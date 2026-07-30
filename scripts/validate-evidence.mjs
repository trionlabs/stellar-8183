#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPOSITORY = "https://github.com/trionlabs/stellar-8183";
const TOKEN_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const TRANSACTION_EXPLORER = "https://stellar.expert/explorer/testnet/tx/";
const CONTRACT_EXPLORER = "https://stellar.expert/explorer/testnet/contract/";
const BUDGET = 10_000_000n;

export const SCENARIOS = Object.freeze({
  completion: {
    id: "completion",
    prefix: "completion",
    description:
      "Create without provider, negotiate, fund 1 test USDC, submit, and complete",
    steps: [
      "create_job",
      "set_provider",
      "set_budget",
      "set_budget",
      "fund",
      "submit",
      "complete",
    ],
    states: [
      "Open",
      "Open",
      "Open",
      "Open",
      "Funded",
      "Submitted",
      "Completed",
    ],
    finalState: "Completed",
    assertions: [
      "client and provider both authorize distinct budget proposals",
      "client loses exactly 10000000 base units",
      "provider receives exactly 10000000 base units",
      "escrow has zero terminal liability",
    ],
  },
  refund: {
    id: "refund",
    prefix: "refund",
    description:
      "Fund, reach ledger-time expiry, and claim a permissionless refund",
    steps: ["create_job", "set_provider", "set_budget", "fund", "claim_refund"],
    states: ["Open", "Open", "Open", "Funded", "Expired"],
    finalState: "Expired",
    assertions: [
      "claim_refund has no role authorizer",
      "client receives the full 10000000 base-unit refund",
      "refund emits no SLA-hook event",
    ],
  },
  open_rejection: {
    id: "open-rejection",
    prefix: "open_rejection",
    description: "Client rejects an unfunded Open job",
    steps: ["create_job", "reject"],
    states: ["Open", "Rejected"],
    finalState: "Rejected",
    assertions: [
      "client authorizes the Open-state rejection",
      "rejection moves no token balance",
    ],
  },
  evaluator_rejection: {
    id: "evaluator-rejection",
    prefix: "evaluator_rejection",
    description: "Evaluator rejects a funded job",
    steps: ["create_job", "set_provider", "set_budget", "fund", "reject"],
    states: ["Open", "Open", "Open", "Funded", "Rejected"],
    finalState: "Rejected",
    assertions: [
      "evaluator authorizes the Funded-state rejection",
      "client receives the full 10000000 base-unit refund",
      "escrow has zero terminal liability",
    ],
  },
});

function fail(path, message) {
  throw new Error(`evidence semantic validation failed at ${path}: ${message}`);
}

function requireCondition(condition, path, message) {
  if (!condition) {
    fail(path, message);
  }
}

function stable(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function requireEqual(actual, expected, path) {
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
    fail(
      path,
      `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function requireExactKeys(value, required, optional, path) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    path,
    "must be an object",
  );
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  requireCondition(
    actual.every((key) => allowed.includes(key)) &&
      required.every((key) => actual.includes(key)),
    path,
    `must contain only the whitelisted fields: ${allowed.sort().join(", ")}`,
  );
}

function validateRawShape(raw) {
  requireExactKeys(
    raw,
    [
      "schema",
      "generatedAt",
      "network",
      "contracts",
      "token",
      "source",
      "identities",
      "transactions",
      "jobs",
      "balances",
    ],
    [],
    "raw",
  );
  requireExactKeys(raw.network, ["name", "passphrase"], [], "raw.network");
  requireExactKeys(
    raw.contracts,
    ["kernel", "token", "hook", "hookReviewSeconds"],
    [],
    "raw.contracts",
  );
  requireExactKeys(raw.token, ["contractId", "decimals"], [], "raw.token");
  requireExactKeys(
    raw.source,
    ["commitSha", "kernelWasmSha256", "hookWasmSha256"],
    [],
    "raw.source",
  );
  requireExactKeys(
    raw.identities,
    ["admin", "client", "provider", "evaluator", "facilitator"],
    [],
    "raw.identities",
  );
  for (const [index, transaction] of raw.transactions.entries()) {
    const path = `raw.transactions[${index}]`;
    requireExactKeys(
      transaction,
      [
        "label",
        "method",
        "hash",
        "explorerUrl",
        "ledger",
        "createdAt",
        "closedAt",
        "fee",
        "minResourceFee",
        "resources",
        "source",
        "contractId",
        "authorizers",
        "argumentsSha256",
        "envelopeSha256",
        "resultXdr",
        "contractEventsXdr",
        "decodedEvents",
        "balanceChanges",
      ],
      ["returnValueXdr"],
      path,
    );
    requireExactKeys(
      transaction.resources,
      [
        "instructions",
        "readBytes",
        "writeBytes",
        "readOnlyEntries",
        "readWriteEntries",
        "declaredResourceFee",
        "inclusionFee",
        "totalFee",
      ],
      [],
      `${path}.resources`,
    );
    transaction.decodedEvents.forEach((event, eventIndex) => {
      requireExactKeys(
        event,
        ["contractId", "name", "decoded"],
        [],
        `${path}.decodedEvents[${eventIndex}]`,
      );
    });
    transaction.balanceChanges.forEach((change, changeIndex) => {
      requireExactKeys(
        change,
        ["label", "address", "before", "after", "delta"],
        [],
        `${path}.balanceChanges[${changeIndex}]`,
      );
    });
  }
  for (const [index, job] of raw.jobs.entries()) {
    requireExactKeys(
      job,
      [
        "label",
        "id",
        "state",
        "client",
        "evaluator",
        "descriptionSha256",
        "budget",
        "expiresAt",
      ],
      ["provider", "hook", "workHash", "decision"],
      `raw.jobs[${index}]`,
    );
  }
  for (const [index, balance] of raw.balances.entries()) {
    requireExactKeys(
      balance,
      ["label", "address", "before", "after", "delta"],
      [],
      `raw.balances[${index}]`,
    );
  }
}

function amount(value, path) {
  try {
    return BigInt(value);
  } catch {
    fail(path, "must be a base-10 integer string");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCanonicalBase64(value, path) {
  requireCondition(
    typeof value === "string" && value.length > 0,
    path,
    "must be a non-empty base64 XDR value",
  );
  const decoded = Buffer.from(value, "base64");
  requireCondition(
    decoded.length > 0 && decoded.toString("base64") === value,
    path,
    "must use canonical base64 encoding",
  );
}

function rawEventToManifest(event) {
  return {
    contract_id: event.contractId,
    name: event.name,
    decoded: event.decoded,
  };
}

function rawBalanceToManifest(change) {
  return {
    address: change.address,
    before_base_units: change.before,
    after_base_units: change.after,
    delta_base_units: change.delta,
  };
}

export function rawTransactionToManifest(raw, step, functionName = raw.method) {
  return {
    step,
    hash: raw.hash,
    ledger: raw.ledger,
    closed_at: raw.closedAt,
    result: "SUCCESS",
    explorer_url: raw.explorerUrl,
    source: raw.source,
    authorizers: [...raw.authorizers],
    contract_id: raw.contractId,
    function: functionName,
    arguments_sha256: raw.argumentsSha256,
    envelope_sha256: raw.envelopeSha256,
    resources: {
      instructions: raw.resources.instructions,
      read_bytes: raw.resources.readBytes,
      write_bytes: raw.resources.writeBytes,
      resource_fee_stroops: raw.resources.declaredResourceFee,
      inclusion_fee_stroops: raw.resources.inclusionFee,
    },
    events: raw.decodedEvents.map(rawEventToManifest),
    balance_changes: raw.balanceChanges.map(rawBalanceToManifest),
  };
}

function flattenTransactions(evidence) {
  return [
    evidence.contracts.kernel.deployment_transaction,
    evidence.contracts.sla_hook.deployment_transaction,
    evidence.contracts.hook_admission_transaction,
    ...evidence.scenarios.flatMap((scenario) => scenario.transactions),
  ];
}

function expectedAuthorizers(kind, step, occurrence, identities) {
  if (step === "claim_refund") {
    return [];
  }
  if (step === "create_job" || step === "set_provider" || step === "fund") {
    return [identities.client];
  }
  if (step === "submit") {
    return [identities.provider];
  }
  if (step === "complete") {
    return [identities.evaluator];
  }
  if (step === "reject") {
    return [
      kind === "open_rejection" ? identities.client : identities.evaluator,
    ];
  }
  if (step === "set_budget") {
    if (kind === "completion" && occurrence === 0) {
      return [identities.client];
    }
    return [identities.provider];
  }
  fail(`scenarios.${kind}.transactions`, `unsupported step ${step}`);
}

function expectedCoreEvents(kind, step) {
  const base = {
    create_job: ["job_created"],
    set_provider: ["provider_set"],
    set_budget: ["budget_set"],
    fund: ["job_funded"],
    submit: ["job_submitted"],
    complete: ["job_completed", "payment_released"],
    claim_refund: ["job_expired", "refunded"],
  };
  if (step === "reject") {
    return kind === "open_rejection"
      ? ["job_rejected"]
      : ["job_rejected", "refunded"];
  }
  return base[step] ?? [];
}

function expectedDeltas(kind, step, identities, kernelId) {
  const deltas = new Map([
    [identities.client, 0n],
    [identities.provider, 0n],
    [identities.evaluator, 0n],
    [kernelId, 0n],
  ]);
  if (step === "fund") {
    deltas.set(identities.client, -BUDGET);
    deltas.set(kernelId, BUDGET);
  } else if (step === "complete") {
    deltas.set(identities.provider, BUDGET);
    deltas.set(kernelId, -BUDGET);
  } else if (
    step === "claim_refund" ||
    (step === "reject" && kind !== "open_rejection")
  ) {
    deltas.set(identities.client, BUDGET);
    deltas.set(kernelId, -BUDGET);
  }
  return deltas;
}

function validateBalanceChanges(
  transaction,
  rawTransaction,
  kind,
  path,
  identities,
  kernelId,
) {
  const expected = expectedDeltas(kind, transaction.step, identities, kernelId);
  const labels = new Map([
    [identities.client, "client"],
    [identities.provider, "provider"],
    [identities.evaluator, "evaluator"],
    [kernelId, "escrow"],
  ]);
  requireCondition(
    transaction.balance_changes.length === expected.size,
    `${path}.balance_changes`,
    "must contain exactly client, provider, evaluator, and escrow",
  );
  const observed = new Map();
  for (const [index, change] of transaction.balance_changes.entries()) {
    const changePath = `${path}.balance_changes[${index}]`;
    requireCondition(
      !observed.has(change.address),
      `${changePath}.address`,
      "duplicate balance address",
    );
    const before = amount(change.before_base_units, `${changePath}.before`);
    const after = amount(change.after_base_units, `${changePath}.after`);
    const delta = amount(change.delta_base_units, `${changePath}.delta`);
    requireEqual(
      rawTransaction.balanceChanges[index].label,
      labels.get(change.address),
      `${changePath} <-> raw label`,
    );
    requireCondition(
      after - before === delta,
      changePath,
      "after - before does not equal delta",
    );
    observed.set(change.address, delta);
  }
  requireEqual(
    [...observed.entries()].sort(),
    [...expected.entries()].sort(),
    `${path}.balance_changes`,
  );
}

function validateRawTransaction(raw, transaction, path) {
  requireEqual(
    transaction,
    rawTransactionToManifest(raw, transaction.step, transaction.function),
    path,
  );
  requireCondition(
    raw.createdAt * 1000 === Date.parse(raw.closedAt),
    `${path}.closed_at`,
    "raw createdAt and closedAt disagree",
  );
  requireCondition(
    Number.isSafeInteger(raw.createdAt) && raw.createdAt > 0,
    `${path}.createdAt`,
    "must be a positive Unix timestamp",
  );
  for (const field of [
    "instructions",
    "readBytes",
    "writeBytes",
    "readOnlyEntries",
    "readWriteEntries",
  ]) {
    requireCondition(
      Number.isSafeInteger(raw.resources[field]) && raw.resources[field] >= 0,
      `${path}.resources.${field}`,
      "must be a non-negative safe integer",
    );
  }
  const declared = amount(
    raw.resources.declaredResourceFee,
    `${path}.resources.declaredResourceFee`,
  );
  const inclusion = amount(
    raw.resources.inclusionFee,
    `${path}.resources.inclusionFee`,
  );
  const total = amount(raw.resources.totalFee, `${path}.resources.totalFee`);
  requireCondition(
    declared >= 0n &&
      inclusion >= 0n &&
      total > 0n &&
      declared + inclusion === total &&
      amount(raw.fee, `${path}.fee`) === total,
    `${path}.resources`,
    "non-negative resource and inclusion fees must equal a positive total fee",
  );
  const minimum = amount(raw.minResourceFee, `${path}.minResourceFee`);
  requireCondition(
    minimum >= 0n && minimum <= declared,
    `${path}.minResourceFee`,
    "must be non-negative and not exceed the declared resource fee",
  );
  requireCanonicalBase64(raw.resultXdr, `${path}.resultXdr`);
  if (raw.returnValueXdr !== undefined) {
    requireCanonicalBase64(raw.returnValueXdr, `${path}.returnValueXdr`);
  }
  raw.contractEventsXdr.forEach((event, index) => {
    requireCanonicalBase64(event, `${path}.contractEventsXdr[${index}]`);
  });
  requireCondition(
    raw.contractEventsXdr.length === raw.decodedEvents.length,
    `${path}.decodedEvents`,
    "decoded event count differs from contract event XDR count",
  );
}

function validateSnapshot(
  snapshot,
  rawJob,
  scenario,
  expected,
  index,
  identities,
  hookId,
) {
  const path = `scenarios.${scenario.id}.job_snapshots[${index}]`;
  requireCondition(
    snapshot.id === scenario.job_id,
    `${path}.id`,
    "wrong job ID",
  );
  requireCondition(
    snapshot.after_step === scenario.transactions[index].step,
    `${path}.after_step`,
    "must identify the corresponding transaction step",
  );
  requireEqual(snapshot.client, identities.client, `${path}.client`);
  requireEqual(snapshot.evaluator, identities.evaluator, `${path}.evaluator`);
  requireEqual(snapshot.hook, hookId, `${path}.hook`);
  requireEqual(snapshot.state, expected.states[index], `${path}.state`);

  const expectedProvider =
    scenario.transactions[index].step === "create_job" ||
    scenario.kind === "open_rejection"
      ? null
      : identities.provider;
  requireEqual(snapshot.provider, expectedProvider, `${path}.provider`);

  const step = scenario.transactions[index].step;
  const budget = amount(
    snapshot.budget_base_units,
    `${path}.budget_base_units`,
  );
  if (
    scenario.kind === "open_rejection" ||
    ["create_job", "set_provider"].includes(step)
  ) {
    requireCondition(
      budget === 0n,
      `${path}.budget_base_units`,
      "must be zero",
    );
  } else if (
    scenario.kind === "completion" &&
    step === "set_budget" &&
    index === 2
  ) {
    requireCondition(
      budget > 0n && budget !== BUDGET,
      `${path}.budget_base_units`,
      "client negotiation proposal must be positive and differ from final budget",
    );
  } else {
    requireCondition(
      budget === BUDGET,
      `${path}.budget_base_units`,
      "must equal the 1 test-USDC budget",
    );
  }

  const submitted =
    scenario.kind === "completion" && ["submit", "complete"].includes(step);
  requireCondition(
    submitted === (snapshot.deliverable_hash !== null),
    `${path}.deliverable_hash`,
    "deliverable commitment presence disagrees with state",
  );
  const decided =
    (scenario.kind === "completion" && step === "complete") ||
    (["open_rejection", "evaluator_rejection"].includes(scenario.kind) &&
      step === "reject");
  requireCondition(
    decided === (snapshot.decision_hash !== null),
    `${path}.decision_hash`,
    "decision commitment presence disagrees with state",
  );

  const rawComparable = {
    id: String(snapshot.id),
    state: snapshot.state,
    client: snapshot.client,
    provider: snapshot.provider ?? undefined,
    evaluator: snapshot.evaluator,
    descriptionSha256: snapshot.description_sha256,
    budget: snapshot.budget_base_units,
    expiresAt: String(snapshot.expires_at),
    hook: snapshot.hook ?? undefined,
    workHash: snapshot.deliverable_hash ?? undefined,
    decision: snapshot.decision_hash ?? undefined,
  };
  const { label: rawLabel, ...rawJobWithoutLabel } = rawJob;
  requireCondition(
    typeof rawLabel === "string" && rawLabel.includes("."),
    `${path} <-> raw job.label`,
    "raw snapshot label is malformed",
  );
  requireEqual(rawJobWithoutLabel, rawComparable, `${path} <-> raw job`);
}

function validateScenario(
  scenario,
  rawByHash,
  raw,
  identities,
  kernelId,
  hookId,
) {
  const expected = SCENARIOS[scenario.kind];
  const path = `scenarios.${scenario.id}`;
  requireCondition(expected !== undefined, path, "unknown scenario kind");
  requireEqual(scenario.id, expected.id, `${path}.id`);
  requireEqual(
    scenario.description,
    expected.description,
    `${path}.description`,
  );
  requireEqual(
    scenario.final_state,
    expected.finalState,
    `${path}.final_state`,
  );
  requireEqual(scenario.assertions, expected.assertions, `${path}.assertions`);
  requireEqual(
    scenario.transactions.map(({ step }) => step),
    expected.steps,
    `${path}.transactions`,
  );
  requireCondition(
    scenario.job_snapshots.length === scenario.transactions.length,
    `${path}.job_snapshots`,
    "must contain one snapshot after every transaction",
  );

  const rawTransactions = scenario.transactions.map((transaction, index) => {
    const transactionPath = `${path}.transactions[${index}]`;
    const rawTransaction = rawByHash.get(transaction.hash);
    requireCondition(
      rawTransaction !== undefined,
      transactionPath,
      "transaction is absent from raw capture",
    );
    requireCondition(
      rawTransaction.label.startsWith(`${expected.prefix}.`),
      `${transactionPath}.step`,
      `raw label must use ${expected.prefix} prefix`,
    );
    requireEqual(
      rawTransaction.method,
      transaction.function,
      `${transactionPath}.function`,
    );
    requireEqual(
      transaction.function,
      transaction.step,
      `${transactionPath}.function`,
    );
    requireEqual(
      transaction.source,
      identities.facilitator,
      `${transactionPath}.source`,
    );
    requireEqual(
      transaction.contract_id,
      kernelId,
      `${transactionPath}.contract_id`,
    );
    validateRawTransaction(rawTransaction, transaction, transactionPath);

    const occurrence = expected.steps
      .slice(0, index)
      .filter((step) => step === transaction.step).length;
    requireEqual(
      [...transaction.authorizers].sort(),
      expectedAuthorizers(
        scenario.kind,
        transaction.step,
        occurrence,
        identities,
      ).sort(),
      `${transactionPath}.authorizers`,
    );
    validateBalanceChanges(
      transaction,
      rawTransaction,
      scenario.kind,
      transactionPath,
      identities,
      kernelId,
    );

    const coreEventNames = new Set(
      transaction.events
        .filter(({ contract_id }) => contract_id === kernelId)
        .map(({ name }) => name),
    );
    for (const eventName of expectedCoreEvents(
      scenario.kind,
      transaction.step,
    )) {
      requireCondition(
        coreEventNames.has(eventName),
        `${transactionPath}.events`,
        `missing kernel event ${eventName}`,
      );
    }
    if (transaction.step === "claim_refund") {
      requireCondition(
        transaction.events.every(({ contract_id }) => contract_id !== hookId),
        `${transactionPath}.events`,
        "claim_refund must not emit an SLA-hook event",
      );
    }
    return rawTransaction;
  });

  const prefixes = new Set(
    rawTransactions.map(({ label }) => label.slice(0, label.indexOf("."))),
  );
  requireCondition(
    prefixes.size === 1,
    path,
    "raw transaction prefixes disagree",
  );
  const prefix = [...prefixes][0];
  const rawJobs = raw.jobs.filter(({ label }) =>
    label.startsWith(`${prefix}.`),
  );
  requireCondition(
    rawJobs.length === scenario.job_snapshots.length,
    `${path}.job_snapshots`,
    "raw job snapshot count differs",
  );

  for (const [index, snapshot] of scenario.job_snapshots.entries()) {
    validateSnapshot(
      snapshot,
      rawJobs[index],
      scenario,
      expected,
      index,
      identities,
      hookId,
    );
  }

  const expiries = new Set(
    scenario.job_snapshots.map(({ expires_at }) => expires_at),
  );
  const descriptions = new Set(
    scenario.job_snapshots.map(({ description_sha256 }) => description_sha256),
  );
  requireCondition(expiries.size === 1, path, "snapshot expiries disagree");
  requireCondition(
    descriptions.size === 1,
    path,
    "snapshot description commitments disagree",
  );

  const continuity = new Map();
  for (const [index, transaction] of scenario.transactions.entries()) {
    for (const change of transaction.balance_changes) {
      const prior = continuity.get(change.address);
      if (prior !== undefined) {
        requireEqual(
          change.before_base_units,
          prior,
          `${path}.transactions[${index}].balance_changes`,
        );
      }
      continuity.set(change.address, change.after_base_units);
    }
  }

  const rawBalances = raw.balances.filter(({ label }) =>
    label.startsWith(`${prefix}.`),
  );
  requireCondition(
    rawBalances.length === 4,
    `${path} <-> raw balances`,
    "must contain client, provider, evaluator, and escrow scenario totals",
  );
  for (const balance of rawBalances) {
    const changes = rawTransactions
      .flatMap(({ balanceChanges }) => balanceChanges)
      .filter(({ address }) => address === balance.address);
    requireCondition(
      changes.length === scenario.transactions.length,
      `${path} <-> raw balances.${balance.address}`,
      "missing per-transaction balance change",
    );
    const aggregate = changes.reduce(
      (sum, change) => sum + amount(change.delta, path),
      0n,
    );
    requireCondition(
      amount(balance.before, path) === amount(changes[0].before, path) &&
        amount(balance.after, path) === amount(changes.at(-1).after, path) &&
        aggregate === amount(balance.delta, path),
      `${path} <-> raw balances.${balance.address}`,
      "scenario total disagrees with per-transaction balance changes",
    );
  }
}

function validateArtifacts(evidence, rawBytes) {
  const artifacts = new Map(
    evidence.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  requireCondition(
    artifacts.size === evidence.artifacts.length,
    "artifacts",
    "artifact names must be unique",
  );
  requireEqual(
    [...artifacts.keys()].sort(),
    [
      "demo_recording",
      "kernel_wasm",
      "raw_testnet_capture",
      "sdk_tarball",
      "sla_hook_wasm",
    ],
    "artifacts.names",
  );
  requireEqual(
    artifacts.get("kernel_wasm").sha256,
    evidence.contracts.kernel.local_wasm_sha256,
    "artifacts.kernel_wasm.sha256",
  );
  requireEqual(
    artifacts.get("sla_hook_wasm").sha256,
    evidence.contracts.sla_hook.local_wasm_sha256,
    "artifacts.sla_hook_wasm.sha256",
  );
  requireEqual(
    artifacts.get("sdk_tarball").sha256,
    evidence.sdk.tarball_sha256,
    "artifacts.sdk_tarball.sha256",
  );
  requireEqual(
    artifacts.get("demo_recording").sha256,
    evidence.demo.recording_sha256,
    "artifacts.demo_recording.sha256",
  );
  const rawArtifact = artifacts.get("raw_testnet_capture");
  requireEqual(
    rawArtifact.path,
    "deployments/testnet.raw.json",
    "artifacts.raw_testnet_capture.path",
  );
  requireEqual(
    rawArtifact.media_type,
    "application/json",
    "artifacts.raw_testnet_capture.media_type",
  );
  requireEqual(
    rawArtifact.bytes,
    rawBytes.length,
    "artifacts.raw_testnet_capture.bytes",
  );
  requireEqual(
    rawArtifact.sha256,
    sha256(rawBytes),
    "artifacts.raw_testnet_capture.sha256",
  );
}

export function validateEvidenceSemantics(evidence, raw, rawBytes) {
  validateRawShape(raw);
  requireEqual(
    evidence.release.source_repository,
    REPOSITORY,
    "release.source_repository",
  );
  requireEqual(raw.schema, "stellar-8183/raw-testnet-capture/v1", "raw.schema");
  requireEqual(raw.network.name, "testnet", "raw.network.name");
  requireEqual(
    raw.network.passphrase,
    NETWORK_PASSPHRASE,
    "raw.network.passphrase",
  );
  requireEqual(
    evidence.network.passphrase,
    NETWORK_PASSPHRASE,
    "network.passphrase",
  );
  requireEqual(
    raw.contracts.kernel,
    evidence.contracts.kernel.contract_id,
    "raw.contracts.kernel",
  );
  requireEqual(
    raw.contracts.hook,
    evidence.contracts.sla_hook.contract_id,
    "raw.contracts.hook",
  );
  requireEqual(
    raw.contracts.hookReviewSeconds,
    evidence.contracts.sla_hook.constructor.review_secs,
    "raw.contracts.hookReviewSeconds",
  );
  requireEqual(raw.contracts.token, TOKEN_ID, "raw.contracts.token");
  requireEqual(raw.token, { contractId: TOKEN_ID, decimals: 7 }, "raw.token");
  requireEqual(
    raw.source.commitSha,
    evidence.release.source_commit,
    "raw.source.commitSha",
  );
  requireEqual(
    raw.source.kernelWasmSha256,
    evidence.contracts.kernel.local_wasm_sha256,
    "raw.source.kernelWasmSha256",
  );
  requireEqual(
    raw.source.hookWasmSha256,
    evidence.contracts.sla_hook.local_wasm_sha256,
    "raw.source.hookWasmSha256",
  );
  requireEqual(raw.identities, evidence.identities, "raw.identities");
  requireCondition(
    new Set(Object.values(evidence.identities)).size === 5,
    "identities",
    "all five role addresses must be distinct",
  );
  requireEqual(
    evidence.contracts.kernel.constructor,
    { admin: evidence.identities.admin, token: TOKEN_ID },
    "contracts.kernel.constructor",
  );
  requireEqual(
    evidence.contracts.sla_hook.constructor.kernel,
    evidence.contracts.kernel.contract_id,
    "contracts.sla_hook.constructor.kernel",
  );
  requireEqual(
    evidence.contracts.kernel.local_wasm_sha256,
    evidence.contracts.kernel.fetched_wasm_sha256,
    "contracts.kernel.fetched_wasm_sha256",
  );
  requireEqual(
    evidence.contracts.sla_hook.local_wasm_sha256,
    evidence.contracts.sla_hook.fetched_wasm_sha256,
    "contracts.sla_hook.fetched_wasm_sha256",
  );
  requireEqual(
    evidence.contracts.kernel.explorer_url,
    `${CONTRACT_EXPLORER}${evidence.contracts.kernel.contract_id}`,
    "contracts.kernel.explorer_url",
  );
  requireEqual(
    evidence.contracts.sla_hook.explorer_url,
    `${CONTRACT_EXPLORER}${evidence.contracts.sla_hook.contract_id}`,
    "contracts.sla_hook.explorer_url",
  );
  if (evidence.status === "deployment") {
    requireEqual(evidence.generated_at, raw.generatedAt, "generated_at");
  }

  validateArtifacts(evidence, rawBytes);

  const allTransactions = flattenTransactions(evidence);
  requireCondition(
    new Set(allTransactions.map(({ hash }) => hash)).size ===
      allTransactions.length,
    "transactions.hash",
    "transaction hashes must be globally unique",
  );
  requireCondition(
    new Set(allTransactions.map(({ envelope_sha256 }) => envelope_sha256))
      .size === allTransactions.length,
    "transactions.envelope_sha256",
    "envelope hashes must be globally unique",
  );
  requireCondition(
    raw.transactions.length === allTransactions.length,
    "raw.transactions",
    "raw and manifest transaction counts differ",
  );
  const rawByHash = new Map(
    raw.transactions.map((transaction) => [transaction.hash, transaction]),
  );
  requireCondition(
    rawByHash.size === raw.transactions.length,
    "raw.transactions.hash",
    "raw transaction hashes must be unique",
  );

  const external = [
    {
      rawLabel: "deploy_kernel",
      transaction: evidence.contracts.kernel.deployment_transaction,
      step: "deploy_kernel",
      functionName: "__constructor",
      contractId: evidence.contracts.kernel.contract_id,
    },
    {
      rawLabel: "deploy_sla_hook",
      transaction: evidence.contracts.sla_hook.deployment_transaction,
      step: "deploy_sla_hook",
      functionName: "__constructor",
      contractId: evidence.contracts.sla_hook.contract_id,
    },
    {
      rawLabel: "admit_hook",
      transaction: evidence.contracts.hook_admission_transaction,
      step: "admit_hook",
      functionName: "set_hook",
      contractId: evidence.contracts.kernel.contract_id,
    },
  ];
  for (const item of external) {
    const rawTransaction = rawByHash.get(item.transaction.hash);
    requireCondition(
      rawTransaction !== undefined,
      `contracts.${item.rawLabel}`,
      "transaction is absent from raw capture",
    );
    requireEqual(
      rawTransaction.label,
      item.rawLabel,
      `raw.${item.rawLabel}.label`,
    );
    requireEqual(
      rawTransaction.method,
      item.functionName,
      `raw.${item.rawLabel}.method`,
    );
    requireEqual(
      item.transaction.step,
      item.step,
      `contracts.${item.rawLabel}.step`,
    );
    requireEqual(
      item.transaction.function,
      item.functionName,
      `contracts.${item.rawLabel}.function`,
    );
    requireEqual(
      item.transaction.contract_id,
      item.contractId,
      `contracts.${item.rawLabel}.contract_id`,
    );
    requireEqual(
      item.transaction.source,
      evidence.identities.admin,
      `contracts.${item.rawLabel}.source`,
    );
    validateRawTransaction(
      rawTransaction,
      item.transaction,
      `contracts.${item.rawLabel}`,
    );
    if (item.step === "admit_hook") {
      requireCondition(
        item.transaction.events.some(
          ({ contract_id, name }) =>
            contract_id === evidence.contracts.kernel.contract_id &&
            name === "hook_set",
        ),
        "contracts.admit_hook.events",
        "hook admission is missing the kernel hook_set event",
      );
    }
  }

  requireCondition(
    evidence.scenarios.length === 4,
    "scenarios",
    "must contain exactly four scenarios",
  );
  requireEqual(
    evidence.scenarios.map(({ kind }) => kind).sort(),
    Object.keys(SCENARIOS).sort(),
    "scenarios.kind",
  );
  requireCondition(
    new Set(evidence.scenarios.map(({ job_id }) => job_id)).size === 4,
    "scenarios.job_id",
    "scenario job IDs must be distinct",
  );
  for (const scenario of evidence.scenarios) {
    validateScenario(
      scenario,
      rawByHash,
      raw,
      evidence.identities,
      evidence.contracts.kernel.contract_id,
      evidence.contracts.sla_hook.contract_id,
    );
  }

  const ledgers = allTransactions.map(({ ledger }) => ledger);
  requireEqual(
    evidence.network.first_ledger,
    Math.min(...ledgers),
    "network.first_ledger",
  );
  requireEqual(
    evidence.network.last_ledger,
    Math.max(...ledgers),
    "network.last_ledger",
  );
  for (const [index, transaction] of allTransactions.entries()) {
    requireEqual(
      transaction.explorer_url,
      `${TRANSACTION_EXPLORER}${transaction.hash}`,
      `transactions[${index}].explorer_url`,
    );
    requireCondition(
      transaction.ledger >= evidence.network.first_ledger &&
        transaction.ledger <= evidence.network.last_ledger,
      `transactions[${index}].ledger`,
      "outside recorded ledger range",
    );
    requireCondition(
      !Number.isNaN(Date.parse(transaction.closed_at)),
      `transactions[${index}].closed_at`,
      "invalid close timestamp",
    );
  }

  const scenarioPrefixes = new Set(
    Object.values(SCENARIOS).map(({ prefix }) => prefix),
  );
  requireCondition(
    raw.jobs.every(({ label }) =>
      scenarioPrefixes.has(label.slice(0, label.indexOf("."))),
    ),
    "raw.jobs",
    "contains an unrecognized scenario label",
  );
  requireCondition(
    raw.jobs.length ===
      evidence.scenarios.reduce(
        (count, scenario) => count + scenario.job_snapshots.length,
        0,
      ),
    "raw.jobs",
    "raw capture contains an ignored job snapshot",
  );
  requireCondition(
    raw.balances.length === 16,
    "raw.balances",
    "must contain four aggregate balances for each scenario",
  );

  return true;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`cannot read ${label} ${path}: ${cause.message}`);
  }
}

function main() {
  const [manifestPath, rawPath, ...rest] = process.argv.slice(2);
  if (manifestPath === undefined || rawPath === undefined || rest.length > 0) {
    throw new Error(
      "usage: node scripts/validate-evidence.mjs MANIFEST_JSON RAW_CAPTURE_JSON",
    );
  }
  const rawBytes = readFileSync(rawPath);
  validateEvidenceSemantics(
    readJson(manifestPath, "manifest"),
    JSON.parse(rawBytes.toString("utf8")),
    rawBytes,
  );
  process.stdout.write("Evidence semantic validation passed.\n");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
