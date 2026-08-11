import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  AgenticCommerce,
  EvidenceRecorder,
  STELLAR_ASSET_DECIMALS,
  StellarRelayRpc,
  authorizeRelay,
  commitmentJson,
  facilitateRelay,
  formatUnits,
  parseUnits,
  prepareRelay,
  type AuthorizationSigner,
  type EvidenceBalanceDelta,
  type EvidenceTransaction,
  type Job,
  type PreparedInvocation,
  type RelayReceipt,
} from "@trionlabs/stellar-8183";
import { contract as stellarContract } from "@stellar/stellar-sdk";
import type {
  AssembledTransaction,
  MethodOptions,
} from "@stellar/stellar-sdk/contract";

import {
  assertCompletionTokenMovement,
  assertNoNetTokenMovement,
  type CommerceBalances,
} from "./accounting.js";
import {
  loadDemoConfig,
  loadDemoSigners,
  type DemoConfig,
  type DemoSigners,
} from "./config.js";

interface TokenMethods {
  balance(
    args: { readonly id: string },
    options?: MethodOptions,
  ): Promise<AssembledTransaction<bigint>>;
  decimals(options?: MethodOptions): Promise<AssembledTransaction<number>>;
}

interface SlaHookMethods {
  get_core(options?: MethodOptions): Promise<AssembledTransaction<string>>;
  review_secs(options?: MethodOptions): Promise<AssembledTransaction<bigint>>;
}

interface DemoContext {
  readonly config: DemoConfig;
  readonly signers: DemoSigners;
  readonly commerce: AgenticCommerce;
  readonly rpc: StellarRelayRpc;
  readonly recorder: EvidenceRecorder;
  readonly token: stellarContract.Client & TokenMethods;
  readonly evidenceOutput: string;
}

function logPublic(label: string, value: unknown): void {
  process.stdout.write(`${label}: ${String(value)}\n`);
}

function requireResult<T>(receipt: RelayReceipt<T>, label: string): T {
  if (receipt.result === undefined) {
    throw new Error(`${label} succeeded without a decoded return value`);
  }
  return receipt.result;
}

async function checkpointEvidence(context: DemoContext): Promise<void> {
  const temporary = `${context.evidenceOutput}.${process.pid}.tmp`;
  await writeFile(temporary, context.recorder.toJSON(), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, context.evidenceOutput);
}

function mutationOptions(context: DemoContext): {
  readonly source: string;
} {
  return {
    source: context.signers.facilitator.address,
  };
}

async function execute<T>(
  context: DemoContext,
  label: string,
  prepared: PreparedInvocation<unknown>,
  signers: readonly AuthorizationSigner[],
): Promise<RelayReceipt<T>> {
  const before = await commerceBalances(context);
  const relay = prepareRelay(prepared, { maxFee: context.config.maxFee });
  const signerByAddress = new Map(
    signers.map((signer) => [signer.address, signer]),
  );
  const requiredAddresses = [
    ...new Set(relay.intent.authorizations.map(({ address }) => address)),
  ];
  if (
    requiredAddresses.length !== signerByAddress.size ||
    requiredAddresses.some((address) => !signerByAddress.has(address))
  ) {
    throw new Error(
      `${label} expected auth [${requiredAddresses.join(", ")}], received signer set [${[
        ...signerByAddress.keys(),
      ].join(", ")}]`,
    );
  }

  let request = relay.request;
  for (const address of requiredAddresses) {
    request = await authorizeRelay({
      adapter: context.commerce.adapter,
      rpc: context.rpc,
      request,
      intent: relay.intent,
      signer: signerByAddress.get(address)!,
    });
  }
  const receipt = await facilitateRelay<T>({
    adapter: context.commerce.adapter,
    rpc: context.rpc,
    request,
    intent: relay.intent,
    facilitator: context.signers.facilitator,
  });
  const after = await commerceBalances(context);
  context.recorder.recordTransaction(
    label,
    receipt,
    balanceDeltas(context, before, after),
  );
  await checkpointEvidence(context);
  logPublic(label, receipt.hash);
  return receipt;
}

async function tokenBalance(
  context: DemoContext,
  address: string,
): Promise<bigint> {
  const transaction = await context.token.balance(
    { id: address },
    {
      publicKey: context.signers.facilitator.address,
      restore: false,
    },
  );
  return transaction.result;
}

async function commerceBalances(
  context: DemoContext,
): Promise<CommerceBalances> {
  const [client, provider, evaluator, escrow] = await Promise.all([
    tokenBalance(context, context.signers.client.address),
    tokenBalance(context, context.signers.provider.address),
    tokenBalance(context, context.signers.evaluator.address),
    tokenBalance(context, context.config.kernelContractId),
  ]);
  return { client, provider, evaluator, escrow };
}

function balanceDeltas(
  context: DemoContext,
  before: CommerceBalances,
  after: CommerceBalances,
): readonly EvidenceBalanceDelta[] {
  return [
    {
      label: "client",
      address: context.signers.client.address,
      before: before.client.toString(),
      after: after.client.toString(),
      delta: (after.client - before.client).toString(),
    },
    {
      label: "provider",
      address: context.signers.provider.address,
      before: before.provider.toString(),
      after: after.provider.toString(),
      delta: (after.provider - before.provider).toString(),
    },
    {
      label: "evaluator",
      address: context.signers.evaluator.address,
      before: before.evaluator.toString(),
      after: after.evaluator.toString(),
      delta: (after.evaluator - before.evaluator).toString(),
    },
    {
      label: "escrow",
      address: context.config.kernelContractId,
      before: before.escrow.toString(),
      after: after.escrow.toString(),
      delta: (after.escrow - before.escrow).toString(),
    },
  ];
}

async function recordScenarioBalances(
  context: DemoContext,
  scenario: string,
  before: CommerceBalances,
  after: CommerceBalances,
): Promise<void> {
  context.recorder.recordBalance(
    `${scenario}.client`,
    context.signers.client.address,
    before.client,
    after.client,
  );
  context.recorder.recordBalance(
    `${scenario}.provider`,
    context.signers.provider.address,
    before.provider,
    after.provider,
  );
  context.recorder.recordBalance(
    `${scenario}.evaluator`,
    context.signers.evaluator.address,
    before.evaluator,
    after.evaluator,
  );
  context.recorder.recordBalance(
    `${scenario}.escrow`,
    context.config.kernelContractId,
    before.escrow,
    after.escrow,
  );
  await checkpointEvidence(context);
}

async function snapshotJob(
  context: DemoContext,
  label: string,
  id: bigint,
): Promise<Job> {
  const job = await context.commerce.getJob(id, {
    source: context.signers.facilitator.address,
  });
  context.recorder.recordJob(label, job);
  await checkpointEvidence(context);
  logPublic(`${label}.state`, job.state.tag);
  return job;
}

function assertJobState(
  job: Job,
  expected: Job["state"]["tag"],
  label: string,
): void {
  if (job.state.tag !== expected) {
    throw new Error(`${label} expected ${expected}, received ${job.state.tag}`);
  }
}

async function createJob(
  context: DemoContext,
  scenario: string,
  expiresAt: bigint,
): Promise<bigint> {
  const receipt = await execute<bigint>(
    context,
    `${scenario}.create_job`,
    await context.commerce.createJob(
      {
        client: context.signers.client.address,
        evaluator: context.signers.evaluator.address,
        expiresAt,
        description: context.config.description,
        hook: context.config.hookContractId,
      },
      mutationOptions(context),
    ),
    [context.signers.client],
  );
  const jobId = requireResult(receipt, `${scenario}.create_job`);
  assertJobState(
    await snapshotJob(context, `${scenario}.created`, jobId),
    "Open",
    `${scenario}.created`,
  );
  return jobId;
}

async function createFundedJob(
  context: DemoContext,
  scenario: string,
  budget: bigint,
  expiresAt: bigint,
  negotiateBudget = false,
): Promise<bigint> {
  const jobId = await createJob(context, scenario, expiresAt);
  const options = mutationOptions(context);
  await execute<void>(
    context,
    `${scenario}.set_provider`,
    await context.commerce.setProvider(
      { id: jobId, provider: context.signers.provider.address },
      options,
    ),
    [context.signers.client],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.provider_set`, jobId),
    "Open",
    `${scenario}.provider_set`,
  );

  if (negotiateBudget) {
    const clientProposal = budget > 1n ? budget - 1n : budget + 1n;
    await execute<void>(
      context,
      `${scenario}.client_budget`,
      await context.commerce.setBudget(
        {
          id: jobId,
          actor: context.signers.client.address,
          amount: clientProposal,
        },
        options,
      ),
      [context.signers.client],
    );
    const proposed = await snapshotJob(
      context,
      `${scenario}.client_budget_set`,
      jobId,
    );
    if (proposed.budget !== clientProposal) {
      throw new Error(`${scenario} did not persist the client budget proposal`);
    }
  }

  await execute<void>(
    context,
    `${scenario}.provider_budget`,
    await context.commerce.setBudget(
      {
        id: jobId,
        actor: context.signers.provider.address,
        amount: budget,
      },
      options,
    ),
    [context.signers.provider],
  );
  const budgetSet = await snapshotJob(
    context,
    `${scenario}.provider_budget_set`,
    jobId,
  );
  if (budgetSet.budget !== budget) {
    throw new Error(`${scenario} did not persist the final provider budget`);
  }

  await execute<void>(
    context,
    `${scenario}.fund`,
    await context.commerce.fund({ id: jobId, expectedBudget: budget }, options),
    [context.signers.client],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.funded`, jobId),
    "Funded",
    `${scenario}.funded`,
  );
  return jobId;
}

async function futureExpiry(
  context: DemoContext,
  seconds: number,
): Promise<bigint> {
  return BigInt(await context.rpc.getLatestLedgerCloseTime()) + BigInt(seconds);
}

async function waitForLedgerTime(
  context: DemoContext,
  target: bigint,
): Promise<void> {
  const initialCloseTime = BigInt(await context.rpc.getLatestLedgerCloseTime());
  const remaining = target > initialCloseTime ? target - initialCloseTime : 0n;
  const wallClockDeadline = Date.now() + (Number(remaining) + 120) * 1_000;
  while (true) {
    const closeTime = BigInt(await context.rpc.getLatestLedgerCloseTime());
    if (closeTime >= target) {
      logPublic("refund ledger close time", closeTime);
      return;
    }
    if (Date.now() >= wallClockDeadline) {
      throw new Error(
        `testnet did not reach refund expiry ${target} within the bounded wait`,
      );
    }
    const remainingSeconds = Number(target - closeTime);
    const delay = Math.min(5_000, Math.max(1_000, remainingSeconds * 1_000));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
}

async function runRefundScenario(
  context: DemoContext,
  budget: bigint,
): Promise<void> {
  const scenario = "refund";
  const before = await commerceBalances(context);
  const expiry = await futureExpiry(
    context,
    context.config.refundExpirySeconds,
  );
  const jobId = await createFundedJob(context, scenario, budget, expiry);
  await waitForLedgerTime(context, expiry);
  await execute<void>(
    context,
    `${scenario}.claim_refund`,
    await context.commerce.claimRefund(jobId, mutationOptions(context)),
    [],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.expired`, jobId),
    "Expired",
    `${scenario}.expired`,
  );
  const after = await commerceBalances(context);
  assertNoNetTokenMovement(scenario, before, after);
  await recordScenarioBalances(context, scenario, before, after);
}

async function runOpenRejectionScenario(context: DemoContext): Promise<void> {
  const scenario = "open_rejection";
  const before = await commerceBalances(context);
  const jobId = await createJob(
    context,
    scenario,
    await futureExpiry(context, context.config.expirySeconds),
  );
  const reason = commitmentJson({ decision: "client_rejected", scenario });
  await execute<void>(
    context,
    `${scenario}.reject`,
    await context.commerce.reject(
      { id: jobId, reason },
      mutationOptions(context),
    ),
    [context.signers.client],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.rejected`, jobId),
    "Rejected",
    `${scenario}.rejected`,
  );
  const after = await commerceBalances(context);
  assertNoNetTokenMovement(scenario, before, after);
  await recordScenarioBalances(context, scenario, before, after);
}

async function runFundedRejectionScenario(
  context: DemoContext,
  budget: bigint,
): Promise<void> {
  const scenario = "evaluator_rejection";
  const before = await commerceBalances(context);
  const jobId = await createFundedJob(
    context,
    scenario,
    budget,
    await futureExpiry(context, context.config.expirySeconds),
  );
  const reason = commitmentJson({ decision: "evaluator_rejected", scenario });
  await execute<void>(
    context,
    `${scenario}.reject`,
    await context.commerce.reject(
      { id: jobId, reason },
      mutationOptions(context),
    ),
    [context.signers.evaluator],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.rejected`, jobId),
    "Rejected",
    `${scenario}.rejected`,
  );
  const after = await commerceBalances(context);
  assertNoNetTokenMovement(scenario, before, after);
  await recordScenarioBalances(context, scenario, before, after);
}

async function runCompletionScenario(
  context: DemoContext,
  budget: bigint,
): Promise<void> {
  const scenario = "completion";
  const before = await commerceBalances(context);
  const expiry = await futureExpiry(context, context.config.expirySeconds);
  const jobId = await createFundedJob(context, scenario, budget, expiry, true);
  const latestCloseTime = BigInt(await context.rpc.getLatestLedgerCloseTime());
  const reviewSafetySeconds = 30n;
  if (
    latestCloseTime +
      BigInt(context.config.slaReviewSeconds) +
      reviewSafetySeconds >
    expiry
  ) {
    throw new Error(
      "completion expiry no longer leaves the configured SLA review window",
    );
  }
  const workHash = commitmentJson({
    deliverableUri: context.config.deliverableUri,
    jobId: jobId.toString(),
  });
  await execute<void>(
    context,
    `${scenario}.submit`,
    await context.commerce.submit(
      { id: jobId, workHash },
      mutationOptions(context),
    ),
    [context.signers.provider],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.submitted`, jobId),
    "Submitted",
    `${scenario}.submitted`,
  );

  const reason = commitmentJson({
    decision: "approved",
    jobId: jobId.toString(),
    workHash: Array.from(workHash),
  });
  await execute<void>(
    context,
    `${scenario}.complete`,
    await context.commerce.complete(
      { id: jobId, reason },
      mutationOptions(context),
    ),
    [context.signers.evaluator],
  );
  assertJobState(
    await snapshotJob(context, `${scenario}.completed`, jobId),
    "Completed",
    `${scenario}.completed`,
  );
  const after = await commerceBalances(context);
  assertCompletionTokenMovement(before, after, budget);
  await recordScenarioBalances(context, scenario, before, after);
}

async function createContext(): Promise<DemoContext> {
  const config = loadDemoConfig();
  const signers = loadDemoSigners(config.networkPassphrase);
  const rpc = new StellarRelayRpc(config.rpcUrl);
  const actualNetworkPassphrase = await rpc.getNetworkPassphrase();
  if (actualNetworkPassphrase !== config.networkPassphrase) {
    throw new Error(
      "RPC network passphrase does not match the testnet evidence configuration",
    );
  }
  const commerce = await AgenticCommerce.connect({
    contractId: config.kernelContractId,
    networkPassphrase: config.networkPassphrase,
    publicKey: signers.facilitator.address,
    rpcUrl: config.rpcUrl,
  });
  const token = await stellarContract.Client.from<TokenMethods>({
    contractId: config.tokenContractId,
    networkPassphrase: config.networkPassphrase,
    publicKey: signers.facilitator.address,
    rpcUrl: config.rpcUrl,
  });
  const hook = await stellarContract.Client.from<SlaHookMethods>({
    contractId: config.hookContractId,
    networkPassphrase: config.networkPassphrase,
    publicKey: signers.facilitator.address,
    rpcUrl: config.rpcUrl,
  });
  const readOptions = {
    publicKey: signers.facilitator.address,
    restore: false,
  };
  const [decimals, hookCore, hookReviewSeconds] = await Promise.all([
    token.decimals(readOptions).then(({ result }) => result),
    hook.get_core(readOptions).then(({ result }) => result),
    hook.review_secs(readOptions).then(({ result }) => result),
  ]);
  if (decimals !== STELLAR_ASSET_DECIMALS) {
    throw new Error(
      `token reports ${decimals} decimals; expected ${STELLAR_ASSET_DECIMALS}`,
    );
  }
  if (hookCore !== config.kernelContractId) {
    throw new Error(
      `SLA hook core ${hookCore} does not match kernel ${config.kernelContractId}`,
    );
  }
  if (hookReviewSeconds !== BigInt(config.slaReviewSeconds)) {
    throw new Error(
      `SLA hook review window ${hookReviewSeconds} does not match configured ${config.slaReviewSeconds}`,
    );
  }

  const commerceReadOptions = {
    source: signers.facilitator.address,
  };
  const [deployedAdmin, deployedToken] = await Promise.all([
    commerce.getAdmin(commerceReadOptions),
    commerce.getToken(commerceReadOptions),
  ]);
  if (deployedAdmin !== signers.admin.address) {
    throw new Error(
      `kernel admin ${deployedAdmin} does not match ADMIN_SECRET public key`,
    );
  }
  if (deployedToken !== config.tokenContractId) {
    throw new Error(
      `kernel token ${deployedToken} does not match configured token ${config.tokenContractId}`,
    );
  }
  if (!(await commerce.isHook(config.hookContractId, commerceReadOptions))) {
    throw new Error("configured SLA hook is not admitted by the kernel");
  }

  let initialBalances: bigint[];
  try {
    initialBalances = await Promise.all(
      [
        signers.client.address,
        signers.provider.address,
        signers.evaluator.address,
        config.kernelContractId,
      ].map(async (id) => {
        const balance = await token.balance({ id }, readOptions);
        return balance.result;
      }),
    );
  } catch {
    throw new Error(
      "client, provider, and evaluator must have readable active token trustlines before evidence capture",
    );
  }
  const configuredBudget = parseUnits(config.budget);
  if (configuredBudget <= 0n) {
    throw new Error("JOB_BUDGET must be greater than zero");
  }
  if (initialBalances[0]! < configuredBudget) {
    throw new Error(
      `client balance is below the configured ${formatUnits(configuredBudget)} USDC budget`,
    );
  }

  const recorder = new EvidenceRecorder({
    network: "testnet",
    networkPassphrase: config.networkPassphrase,
    kernelContractId: config.kernelContractId,
    tokenContractId: config.tokenContractId,
    tokenDecimals: decimals,
    hookContractId: config.hookContractId,
    hookReviewSeconds: config.slaReviewSeconds,
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    identities: {
      admin: signers.admin.address,
      client: signers.client.address,
      provider: signers.provider.address,
      evaluator: signers.evaluator.address,
      facilitator: signers.facilitator.address,
    },
    commitSha: config.commitSha,
    kernelWasmSha256: config.kernelWasmSha256,
    hookWasmSha256: config.hookWasmSha256,
  });
  const workspaceRoot = resolve(import.meta.dirname, "../../..");
  const deploymentInput = isAbsolute(config.deploymentEvidenceInput)
    ? config.deploymentEvidenceInput
    : resolve(workspaceRoot, config.deploymentEvidenceInput);
  const deploymentTransactions: unknown = JSON.parse(
    await readFile(deploymentInput, "utf8"),
  );
  if (
    !Array.isArray(deploymentTransactions) ||
    deploymentTransactions.length !== 3
  ) {
    throw new Error(
      "deployment evidence input must contain exactly three transactions",
    );
  }
  const expectedDeploymentSteps = [
    {
      label: "deploy_kernel",
      method: "__constructor",
      contractId: config.kernelContractId,
    },
    {
      label: "deploy_sla_hook",
      method: "__constructor",
      contractId: config.hookContractId,
    },
    {
      label: "admit_hook",
      method: "set_hook",
      contractId: config.kernelContractId,
    },
  ] as const;
  deploymentTransactions.forEach((transaction, index) => {
    const expected = expectedDeploymentSteps[index]!;
    if (
      typeof transaction !== "object" ||
      transaction === null ||
      !("label" in transaction) ||
      !("method" in transaction) ||
      !("contractId" in transaction) ||
      !("source" in transaction) ||
      transaction.label !== expected.label ||
      transaction.method !== expected.method ||
      transaction.contractId !== expected.contractId ||
      transaction.source !== signers.admin.address
    ) {
      throw new Error(
        `deployment evidence transaction ${index} does not match ${expected.label}`,
      );
    }
    recorder.recordExternalTransaction(
      transaction as unknown as EvidenceTransaction,
    );
  });
  const evidenceOutput = isAbsolute(config.rawEvidenceOutput)
    ? config.rawEvidenceOutput
    : resolve(workspaceRoot, config.rawEvidenceOutput);
  return {
    config,
    signers,
    commerce,
    rpc,
    recorder,
    token,
    evidenceOutput,
  };
}

async function run(): Promise<void> {
  const context = await createContext();
  const { config, signers } = context;
  const budget = parseUnits(config.budget);
  const minimumCompletionWindow = config.slaReviewSeconds + 120;
  if (config.expirySeconds <= minimumCompletionWindow) {
    throw new Error(
      `JOB_EXPIRY_SECONDS must exceed SLA_REVIEW_SECS by more than 120 seconds`,
    );
  }
  await mkdir(dirname(context.evidenceOutput), { recursive: true });
  await writeFile(context.evidenceOutput, context.recorder.toJSON(), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  logPublic("kernel", config.kernelContractId);
  logPublic("token", config.tokenContractId);
  logPublic("token decimals", STELLAR_ASSET_DECIMALS);
  logPublic("SLA hook", config.hookContractId);
  logPublic("SLA review seconds", config.slaReviewSeconds);
  logPublic("admin", signers.admin.address);
  logPublic("client", signers.client.address);
  logPublic("provider", signers.provider.address);
  logPublic("evaluator", signers.evaluator.address);
  logPublic("facilitator", signers.facilitator.address);
  logPublic("budget", `${formatUnits(budget)} USDC`);

  // Refund and rejection scenarios return the same 1 USDC to the client, so a
  // minimally funded test identity can reuse it before the terminal completion.
  await runRefundScenario(context, budget);
  await runOpenRejectionScenario(context);
  await runFundedRejectionScenario(context, budget);
  await runCompletionScenario(context, budget);

  await checkpointEvidence(context);
  logPublic("raw evidence", context.evidenceOutput);
}

await run();
