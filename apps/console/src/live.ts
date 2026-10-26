import {
  Account,
  Address,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  StrKey,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  AgenticCommerce,
  commitmentFromHex,
  decodeContractEvent,
  unwrapContractResult,
  inspectInvocation,
  type Job,
  type PreparedContractInvocation,
} from "@trionlabs/stellar-8183";
import { assertBinding, resolveAgent } from "./identity.js";
import {
  address,
  assertAction,
  assertReviewedJob,
  uint,
  validateProfile,
  type Action,
  type AgentBinding,
  type Outcome,
  type Profile,
  type RecordJob,
} from "./model.js";
import { matchReceiptJob, type ReceiptFile } from "./receipt.js";

export interface Wallet {
  address: string;
  sign(xdr: string, profile: Profile): Promise<string>;
}

export interface PendingSubmission {
  hash: string;
  method: "create_job" | Action;
  source: string;
  jobId?: string;
}

const mutationMethods = new Set<string>([
  "create_job",
  "set_provider",
  "set_budget",
  "fund",
  "submit",
  "complete",
  "reject",
  "claim_refund",
]);

export function assertPendingSubmission(
  value: unknown,
): asserts value is PendingSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid pending transaction metadata.");
  const item = value as Record<string, unknown>;
  const fields = Object.keys(item).sort().join();
  if (
    (fields !== "hash,method,source" &&
      fields !== "hash,jobId,method,source") ||
    typeof item.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.hash) ||
    typeof item.method !== "string" ||
    !mutationMethods.has(item.method) ||
    typeof item.source !== "string" ||
    !StrKey.isValidEd25519PublicKey(item.source)
  )
    throw new Error("Invalid pending transaction metadata.");
  if (item.method === "create_job") {
    if ("jobId" in item)
      throw new Error(
        "A pending create transaction cannot claim a job ID before confirmation.",
      );
  } else {
    if (typeof item.jobId !== "string")
      throw new Error("A pending job action requires its job ID.");
    uint(item.jobId);
  }
}

export class ConfirmedJobReadError extends Error {
  constructor(
    readonly jobId: bigint,
    readonly outcome: Outcome,
    readonly binding?: AgentBinding,
    cause?: unknown,
  ) {
    super(
      "The transaction is confirmed, but the updated job could not be read. Keep its job ID and transaction hash, then refresh; do not repeat the action.",
      { cause },
    );
    this.name = "ConfirmedJobReadError";
  }
}

export class UnconfirmedTransactionError extends Error {
  constructor(
    readonly submission: PendingSubmission,
    cause?: unknown,
    readonly binding?: AgentBinding,
  ) {
    super(
      "The transaction was signed, but its final result is not verified. Check its transaction hash before repeating the action.",
      { cause },
    );
    this.name = "UnconfirmedTransactionError";
  }
}

export type SubmissionRecovery =
  | { status: "unknown" }
  | { status: "failed" }
  | { status: "confirmed"; record: RecordJob };

function submissionTransaction(
  profile: Profile,
  pending: PendingSubmission,
  result:
    | rpc.Api.GetSuccessfulTransactionResponse
    | rpc.Api.GetFailedTransactionResponse,
): Transaction {
  if (!Number.isSafeInteger(result.ledger) || result.ledger <= 0)
    throw new Error("Recovered transaction has no valid confirmation ledger.");
  const transaction = TransactionBuilder.fromXDR(
    result.envelopeXdr,
    profile.networkPassphrase,
  );
  if (
    !(transaction instanceof Transaction) ||
    result.txHash !== pending.hash ||
    transaction.hash().toString("hex") !== pending.hash ||
    transaction.source !== pending.source
  )
    throw new Error(
      "Recovered transaction hash, network, or source does not match the pending action.",
    );
  const invocation = inspectInvocation(transaction);
  if (
    invocation.contractId !== profile.kernel ||
    invocation.method !== pending.method
  )
    throw new Error(
      "Recovered transaction invokes a different kernel or method.",
    );
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction")
    throw new Error("Recovered transaction is not a contract invocation.");
  const first = operation.func.invokeContract().args()[0];
  if (
    !first ||
    (pending.method === "create_job"
      ? scValToNative(first) !== pending.source
      : first.switch().name !== "scvU64" ||
        scValToNative(first) !== uint(pending.jobId!))
  )
    throw new Error(
      "Recovered transaction does not match the stated client or job ID.",
    );
  return transaction;
}
export interface NewJob {
  description: string;
  provider?: string;
  evaluator: string;
  expiresAt: bigint;
  hook?: string;
}
export interface ActionInput {
  provider?: string;
  budget?: bigint;
  commitment?: string;
}

export function assertSignedTransaction(
  unsignedXdr: string,
  signedXdr: string,
  profile: Profile,
  owner: string,
): void {
  const original = TransactionBuilder.fromXDR(
    unsignedXdr,
    profile.networkPassphrase,
  );
  const signed = TransactionBuilder.fromXDR(
    signedXdr,
    profile.networkPassphrase,
  );
  if (
    !(original instanceof Transaction) ||
    !(signed instanceof Transaction) ||
    original.source !== owner ||
    !original.hash().equals(signed.hash())
  )
    throw new Error(
      "Wallet returned a changed transaction or a different source account.",
    );
  if (BigInt(original.fee) > BigInt(profile.maxFee))
    throw new Error("The transaction exceeds your fee ceiling.");
  const key = Keypair.fromPublicKey(owner);
  if (
    !signed.signatures.some(
      (sig) =>
        sig.hint().equals(key.signatureHint()) &&
        key.verify(signed.hash(), sig.signature()),
    )
  )
    throw new Error(
      "Wallet did not return a valid signature for the connected account.",
    );
}

export class LiveCommerce {
  readonly server: rpc.Server;
  constructor(
    readonly profile: Profile,
    readonly wallet: Wallet,
  ) {
    validateProfile(profile);
    address(wallet.address);
    this.server = new rpc.Server(profile.rpcUrl, {
      allowHttp: profile.rpcUrl.startsWith("http:"),
    });
  }

  private async kernel(): Promise<AgenticCommerce> {
    return AgenticCommerce.connect({
      contractId: this.profile.kernel,
      rpcUrl: this.profile.rpcUrl,
      networkPassphrase: this.profile.networkPassphrase,
      publicKey: this.wallet.address,
      allowHttp: this.profile.rpcUrl.startsWith("http:"),
    });
  }

  async tokenInfo(): Promise<{ symbol: string; decimals: number }> {
    const core = await this.kernel();
    if (
      (await core.getToken({ source: this.wallet.address })) !==
      this.profile.token
    )
      throw new Error(
        "Configured token does not match the kernel's immutable payment token.",
      );
    const read = async (method: string): Promise<unknown> => {
      const tx = new TransactionBuilder(new Account(this.wallet.address, "0"), {
        networkPassphrase: this.profile.networkPassphrase,
        fee: "100",
      })
        .addOperation(new Contract(this.profile.token).call(method))
        .setTimeout(60)
        .build();
      const result = await this.server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(result) || !result.result)
        throw new Error("Could not read token metadata.");
      return scValToNative(result.result.retval);
    };
    const [symbol, decimals] = await Promise.all([
      read("symbol"),
      read("decimals"),
    ]);
    if (
      typeof symbol !== "string" ||
      typeof decimals !== "number" ||
      decimals !== this.profile.decimals ||
      symbol !== this.profile.symbol
    )
      throw new Error(
        "Token symbol or decimals differ from the selected profile. No transaction was signed.",
      );
    return { symbol, decimals };
  }

  async read(id: bigint): Promise<Job> {
    return (await this.kernel()).getJob(id, { source: this.wallet.address });
  }

  async tokenBalance(owner: string): Promise<bigint> {
    address(owner);
    const tx = new TransactionBuilder(new Account(this.wallet.address, "0"), {
      fee: "100",
      networkPassphrase: this.profile.networkPassphrase,
    })
      .addOperation(
        new Contract(this.profile.token).call(
          "balance",
          new Address(owner).toScVal(),
        ),
      )
      .setTimeout(60)
      .build();
    const result = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(result) || !result.result)
      throw new Error("Could not read token balance.");
    const balance: unknown = scValToNative(result.result.retval);
    if (typeof balance !== "bigint")
      throw new Error("Token returned an invalid balance.");
    return balance;
  }

  private async send<T>(
    prepared: PreparedContractInvocation<T>,
    jobId?: bigint,
  ): Promise<{ value: T; outcome: Outcome }> {
    const context: { submission?: PendingSubmission } = {};
    const expectedArguments = (prepared.transaction.options.args ?? []).map(
      (arg) => arg.toXDR("base64") as string,
    );
    const sent = await prepared.transaction
      .signAndSend({
        force: true,
        signTransaction: async (xdr) => {
          const unsigned = TransactionBuilder.fromXDR(
            xdr,
            this.profile.networkPassphrase,
          );
          if (
            !(unsigned instanceof Transaction) ||
            unsigned.source !== this.wallet.address ||
            BigInt(unsigned.fee) > BigInt(this.profile.maxFee)
          )
            throw new Error("Transaction exceeds the fee ceiling.");
          const invocation = inspectInvocation(unsigned);
          if (
            invocation.contractId !== this.profile.kernel ||
            invocation.method !== prepared.method ||
            JSON.stringify(invocation.argumentXdr) !==
              JSON.stringify(expectedArguments)
          )
            throw new Error(
              "Prepared transaction differs from the reviewed action.",
            );
          const maxTime = Number(unsigned.timeBounds?.maxTime ?? 0);
          const now = Math.floor(Date.now() / 1000);
          if (
            !Number.isSafeInteger(maxTime) ||
            maxTime <= now ||
            maxTime > now + 180
          )
            throw new Error(
              "Transaction has invalid or excessive time bounds.",
            );
          const signedTxXdr = await this.wallet.sign(xdr, this.profile);
          assertSignedTransaction(
            xdr,
            signedTxXdr,
            this.profile,
            this.wallet.address,
          );
          const submission = {
            hash: unsigned.hash().toString("hex"),
            method: prepared.method,
            source: this.wallet.address,
            ...(jobId === undefined ? {} : { jobId: jobId.toString() }),
          };
          assertPendingSubmission(submission);
          context.submission = submission;
          return { signedTxXdr, signerAddress: this.wallet.address };
        },
      })
      .catch((cause: unknown) => {
        if (context.submission)
          throw new UnconfirmedTransactionError(context.submission, cause);
        throw cause;
      });
    const result = sent.getTransactionResponse;
    const hash = sent.sendTransactionResponse?.hash;
    const submission = context.submission;
    if (!submission)
      throw new Error("The wallet did not sign the prepared action.");
    if (!result || result.status !== "SUCCESS" || hash !== submission.hash)
      throw new UnconfirmedTransactionError(submission);
    try {
      submissionTransaction(this.profile, submission, result);
      return {
        value: unwrapContractResult(sent.result, prepared.method),
        outcome: {
          hash: submission.hash,
          ledger: result.ledger,
          method: prepared.method,
        },
      };
    } catch (cause) {
      throw new UnconfirmedTransactionError(submission, cause);
    }
  }

  private async confirmedRecord(
    id: bigint,
    outcome: Outcome,
    binding?: AgentBinding,
  ): Promise<RecordJob> {
    try {
      const job = await this.read(id);
      if (job.id !== id)
        throw new Error("The RPC returned a different job ID.");
      return { job, outcome, binding };
    } catch (cause) {
      throw new ConfirmedJobReadError(id, outcome, binding, cause);
    }
  }

  async recoverSubmission(
    pending: PendingSubmission,
  ): Promise<SubmissionRecovery> {
    assertPendingSubmission(pending);
    const result = await this.server.getTransaction(pending.hash);
    if (result.txHash !== pending.hash)
      throw new Error(
        "RPC transaction hash does not match the pending action.",
      );
    if (result.status === "NOT_FOUND") return { status: "unknown" };
    submissionTransaction(this.profile, pending, result);
    if (result.status === "FAILED") return { status: "failed" };
    let id: bigint;
    if (pending.method === "create_job") {
      if (!result.returnValue || result.returnValue.switch().name !== "scvU64")
        throw new Error(
          "Confirmed create transaction has no valid job ID return value.",
        );
      const value: unknown = scValToNative(result.returnValue);
      if (typeof value !== "bigint")
        throw new Error("Invalid create job return value.");
      id = value;
    } else id = uint(pending.jobId!);
    const outcome = {
      hash: pending.hash,
      ledger: result.ledger,
      method: pending.method,
    };
    return {
      status: "confirmed",
      record: await this.confirmedRecord(id, outcome),
    };
  }

  async create(input: NewJob): Promise<RecordJob> {
    await this.tokenInfo();
    const core = await this.kernel();
    const { value: id, outcome } = await this.send(
      await core.createJob(
        { client: this.wallet.address, ...input },
        { source: this.wallet.address, timeoutInSeconds: 120 },
      ),
    );
    return this.confirmedRecord(id, outcome);
  }

  async act(
    id: bigint,
    action: Action,
    input: ActionInput = {},
    binding?: AgentBinding,
    reviewed?: Job,
  ): Promise<RecordJob> {
    const job = await this.read(id);
    if (reviewed) assertReviewedJob(job, reviewed);
    assertAction(job, action, this.wallet.address);
    if (action === "fund") await this.tokenInfo();
    let snapshot = binding;
    if (binding && action === "fund") {
      snapshot = await resolveAgent(this.profile, binding, this.wallet.address);
      assertBinding(this.profile, snapshot, job.provider ?? "");
    }
    const core = await this.kernel();
    const options = { source: this.wallet.address, timeoutInSeconds: 120 };
    const send = <T>(prepared: PreparedContractInvocation<T>) =>
      this.send(prepared, id);
    let outcome: Outcome;
    try {
      switch (action) {
        case "set_provider":
          outcome = (
            await send(
              await core.setProvider(
                { id, provider: address(input.provider ?? "") },
                options,
              ),
            )
          ).outcome;
          snapshot = undefined;
          break;
        case "set_budget":
          outcome = (
            await send(
              await core.setBudget(
                { id, actor: this.wallet.address, amount: input.budget ?? 0n },
                options,
              ),
            )
          ).outcome;
          break;
        case "fund":
          outcome = (
            await send(
              await core.fund(
                { id, expectedBudget: reviewed?.budget ?? job.budget },
                options,
              ),
            )
          ).outcome;
          break;
        case "submit":
          outcome = (
            await send(
              await core.submit(
                { id, workHash: commitmentFromHex(input.commitment ?? "") },
                options,
              ),
            )
          ).outcome;
          break;
        case "complete":
          outcome = (
            await send(
              await core.complete(
                {
                  id,
                  reason: input.commitment
                    ? commitmentFromHex(input.commitment)
                    : undefined,
                },
                options,
              ),
            )
          ).outcome;
          break;
        case "reject":
          outcome = (
            await send(
              await core.reject(
                {
                  id,
                  reason: input.commitment
                    ? commitmentFromHex(input.commitment)
                    : undefined,
                },
                options,
              ),
            )
          ).outcome;
          break;
        case "claim_refund":
          outcome = (await send(await core.claimRefund(id, options))).outcome;
          break;
      }
    } catch (cause) {
      if (cause instanceof UnconfirmedTransactionError && snapshot)
        throw new UnconfirmedTransactionError(
          cause.submission,
          cause,
          snapshot,
        );
      throw cause;
    }
    return this.confirmedRecord(id, outcome, snapshot);
  }
}

export async function verifyOnChain(
  file: ReceiptFile,
  profile: Profile,
  reader: LiveCommerce,
): Promise<string> {
  const r = file.receipt;
  if (
    r.network !== profile.id ||
    r.networkPassphrase !== profile.networkPassphrase ||
    r.kernel !== profile.kernel ||
    r.token !== profile.token
  )
    throw new Error(
      "Receipt belongs to a different network, kernel, or token.",
    );
  await reader.tokenInfo();
  const [job, tx] = await Promise.all([
    reader.read(uint(r.jobId)),
    reader.server.getTransaction(r.terminalTransaction.hash),
  ]);
  matchReceiptJob(r, job);
  if (tx.status !== "SUCCESS" || tx.ledger !== r.terminalTransaction.ledger)
    throw new Error(
      "Terminal transaction is unavailable, unsuccessful, or has a different ledger. The receipt is not verified.",
    );
  const transaction = TransactionBuilder.fromXDR(
    tx.envelopeXdr,
    profile.networkPassphrase,
  );
  if (
    !(transaction instanceof Transaction) ||
    transaction.operations.length !== 1 ||
    transaction.hash().toString("hex") !== r.terminalTransaction.hash
  )
    throw new Error("Unexpected transaction envelope.");
  const op = transaction.operations[0];
  if (
    op?.type !== "invokeHostFunction" ||
    op.func.switch().name !== "hostFunctionTypeInvokeContract"
  )
    throw new Error("Terminal transaction is not a contract invocation.");
  const invocation = op.func.invokeContract();
  const args = invocation.args();
  if (
    Address.fromScAddress(invocation.contractAddress()).toString() !==
      profile.kernel ||
    invocation.functionName().toString() !== r.terminalTransaction.method ||
    !args[0] ||
    scValToNative(args[0]) !== BigInt(r.jobId)
  )
    throw new Error(
      "Terminal transaction does not settle the stated kernel and job.",
    );
  return "Verified terminal job and settlement transaction. Any 8004 binding is a client snapshot, not an on-chain identity attestation. This does not verify work quality.";
}

export function hasSettlementEvent(
  file: ReceiptFile,
  tx: rpc.Api.GetSuccessfulTransactionResponse,
): boolean {
  const r = file.receipt;
  const events = tx.events.contractEventsXdr
    .flat()
    .filter((event) => event.contractId() !== null)
    .map((event) => decodeContractEvent(event.toXDR("base64")));
  const name = r.state === "Completed" ? "payment_released" : "refunded";
  const payee = r.state === "Completed" ? r.provider : r.client;
  return events.some(
    (event) =>
      event.contractId === r.kernel &&
      event.name === name &&
      Array.isArray(event.decoded.topics) &&
      event.decoded.topics[0] === r.jobId &&
      event.decoded.topics[1] === payee &&
      typeof event.decoded.data === "object" &&
      event.decoded.data !== null &&
      !Array.isArray(event.decoded.data) &&
      (event.decoded.data as Record<string, unknown>).amount === r.budget,
  );
}
