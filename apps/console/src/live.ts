import {
  Account,
  Address,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
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
  ): Promise<{ value: T; outcome: Outcome }> {
    const expectedArguments = (prepared.transaction.options.args ?? []).map(
      (arg) => arg.toXDR("base64") as string,
    );
    const sent = await prepared.transaction.signAndSend({
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
          throw new Error("Transaction has invalid or excessive time bounds.");
        const signedTxXdr = await this.wallet.sign(xdr, this.profile);
        assertSignedTransaction(
          xdr,
          signedTxXdr,
          this.profile,
          this.wallet.address,
        );
        return { signedTxXdr, signerAddress: this.wallet.address };
      },
    });
    const result = sent.getTransactionResponse;
    const hash = sent.sendTransactionResponse?.hash;
    if (!result || result.status !== "SUCCESS" || !hash)
      throw new Error(
        "Transaction has not been confirmed successful. Refresh before retrying.",
      );
    return {
      value: unwrapContractResult(sent.result, prepared.method),
      outcome: { hash, ledger: result.ledger, method: prepared.method },
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
    return { job: await this.read(id), outcome };
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
    let outcome: Outcome;
    switch (action) {
      case "set_provider":
        outcome = (
          await this.send(
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
          await this.send(
            await core.setBudget(
              { id, actor: this.wallet.address, amount: input.budget ?? 0n },
              options,
            ),
          )
        ).outcome;
        break;
      case "fund":
        outcome = (
          await this.send(
            await core.fund(
              { id, expectedBudget: reviewed?.budget ?? job.budget },
              options,
            ),
          )
        ).outcome;
        break;
      case "submit":
        outcome = (
          await this.send(
            await core.submit(
              { id, workHash: commitmentFromHex(input.commitment ?? "") },
              options,
            ),
          )
        ).outcome;
        break;
      case "complete":
        outcome = (
          await this.send(
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
          await this.send(
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
        outcome = (await this.send(await core.claimRefund(id, options)))
          .outcome;
        break;
    }
    return { job: await this.read(id), binding: snapshot, outcome };
  }
}

export async function verifyOnChain(
  file: ReceiptFile,
  profile: Profile,
  reader: LiveCommerce,
): Promise<string> {
  const r = file.receipt;
  if (r.evidenceType !== "on-chain")
    throw new Error("Local rehearsal receipts cannot be verified on-chain.");
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
