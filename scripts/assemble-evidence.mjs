#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SCENARIOS,
  rawTransactionToManifest,
  validateEvidenceSemantics,
} from "./validate-evidence.mjs";

const REPOSITORY = "https://github.com/trionlabs/stellar-8183";
const TOKEN_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TOKEN_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const RPC_URL = "https://soroban-testnet.stellar.org";

function fail(message) {
  throw new Error(`evidence assembly refused: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`cannot parse ${label} ${path}: ${cause.message}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function digest(path, label) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    fail(`cannot read ${label} ${path}: ${cause.message}`);
  }
  requireCondition(bytes.length > 0, `${label} is empty`);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function requireDifferentPaths(first, second, label) {
  requireCondition(
    resolve(first) !== resolve(second),
    `${label} comparison paths must identify independent build outputs`,
  );
}

function requireMatchingArtifacts(first, second, label) {
  requireCondition(
    first.bytes === second.bytes && first.sha256 === second.sha256,
    `${label} artifacts are not byte-identical`,
  );
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    if (values.has(name)) {
      fail(`duplicate argument ${name}`);
    }
    values.set(name, value);
  }
  const required = ["--raw", "--metadata", "--output"];
  for (const name of required) {
    if (!values.has(name)) {
      fail(`missing argument ${name}`);
    }
  }
  for (const name of values.keys()) {
    if (!required.includes(name)) {
      fail(`unknown argument ${name}`);
    }
  }
  return {
    raw: values.get("--raw"),
    metadata: values.get("--metadata"),
    output: values.get("--output"),
  };
}

function validateMetadata(metadata) {
  const topKeys = Object.keys(metadata).sort();
  requireCondition(
    JSON.stringify(topKeys) ===
      JSON.stringify(
        [
          "artifacts",
          "build",
          "network",
          "operator_assertions",
          "sla_review_secs",
        ].sort(),
      ),
    "metadata has missing or unknown top-level fields",
  );
  requireCondition(
    metadata.network.protocol_version === 27,
    "metadata network protocol_version must be 27",
  );
  requireCondition(
    !Number.isNaN(Date.parse(metadata.network.observed_at)),
    "metadata network observed_at must be an ISO-8601 timestamp",
  );
  requireCondition(
    Number.isSafeInteger(metadata.sla_review_secs) &&
      metadata.sla_review_secs > 0,
    "metadata sla_review_secs must be a positive safe integer",
  );
  requireCondition(
    metadata.operator_assertions.all_local_tests_passed === true,
    "local test gate was not asserted",
  );
  requireCondition(
    metadata.operator_assertions.no_secrets_in_artifacts === true,
    "secret-review gate was not asserted",
  );

  const expectedBuildKeys = [
    "node",
    "pnpm",
    "rustc",
    "soroban_sdk",
    "source_repo_metadata",
    "stellar_cli",
    "stellar_sdk",
  ];
  requireCondition(
    JSON.stringify(Object.keys(metadata.build).sort()) ===
      JSON.stringify(expectedBuildKeys.sort()),
    "metadata build fields do not match the evidence build record",
  );
  requireCondition(metadata.build.rustc === "1.96.0", "rustc must be 1.96.0");
  requireCondition(
    /^(?:stellar\s+)?27\.0\.0(?:\s|$)/.test(metadata.build.stellar_cli),
    "stellar CLI must be 27.0.0",
  );
  requireCondition(/^v?22\./.test(metadata.build.node), "Node must be 22.x");
  requireCondition(metadata.build.pnpm === "11.9.0", "pnpm must be 11.9.0");
  requireCondition(
    metadata.build.soroban_sdk === "27.0.3",
    "Soroban SDK must be 27.0.3",
  );
  requireCondition(
    metadata.build.stellar_sdk === "16.2.0",
    "Stellar SDK must be 16.2.0",
  );
  requireCondition(
    metadata.build.source_repo_metadata === "github:trionlabs/stellar-8183",
    "source_repo metadata is wrong",
  );

  const artifactKeys = [
    "demo_recording",
    "kernel_fetched_wasm",
    "kernel_rebuild_wasm",
    "kernel_wasm",
    "sdk_tarball",
    "sla_hook_fetched_wasm",
    "sla_hook_rebuild_wasm",
    "sla_hook_wasm",
  ];
  requireCondition(
    JSON.stringify(Object.keys(metadata.artifacts).sort()) ===
      JSON.stringify(artifactKeys.sort()),
    "metadata artifact paths are missing or unknown",
  );
  for (const [name, path] of Object.entries(metadata.artifacts)) {
    requireCondition(
      typeof path === "string" && path.length > 0,
      `metadata artifact ${name} path is empty`,
    );
  }
}

function findExternal(raw, label, method) {
  const matches = raw.transactions.filter(
    (transaction) =>
      transaction.label === label && transaction.method === method,
  );
  requireCondition(
    matches.length === 1,
    `raw capture must contain exactly one ${label}/${method} transaction`,
  );
  return matches[0];
}

function scenarioTransactions(raw, expected) {
  const transactions = raw.transactions.filter(({ label }) =>
    label.startsWith(`${expected.prefix}.`),
  );
  requireCondition(
    transactions.length === expected.steps.length,
    `${expected.prefix} raw transaction count is wrong`,
  );
  requireCondition(
    JSON.stringify(transactions.map(({ method }) => method)) ===
      JSON.stringify(expected.steps),
    `${expected.prefix} raw transaction order does not match the required lifecycle`,
  );
  return transactions;
}

function scenarioSnapshots(raw, expected, transactions) {
  const jobs = raw.jobs.filter(({ label }) =>
    label.startsWith(`${expected.prefix}.`),
  );
  requireCondition(
    jobs.length === transactions.length,
    `${expected.prefix} must have one raw job snapshot per transaction`,
  );
  const ids = new Set(jobs.map(({ id }) => id));
  requireCondition(ids.size === 1, `${expected.prefix} raw job IDs disagree`);
  const jobId = Number(jobs[0].id);
  requireCondition(
    Number.isSafeInteger(jobId) && jobId > 0,
    `${expected.prefix} job ID is not a positive safe integer`,
  );
  return {
    jobId,
    snapshots: jobs.map((job, index) => ({
      after_step: transactions[index].method,
      id: Number(job.id),
      client: job.client,
      provider: job.provider ?? null,
      evaluator: job.evaluator,
      description_sha256: job.descriptionSha256,
      budget_base_units: job.budget,
      expires_at: Number(job.expiresAt),
      state: job.state,
      hook: job.hook ?? null,
      deliverable_hash: job.workHash ?? null,
      decision_hash: job.decision ?? null,
    })),
  };
}

function makeArtifact(name, path, mediaType, result) {
  return {
    name,
    path,
    media_type: mediaType,
    bytes: result.bytes,
    sha256: result.sha256,
  };
}

export function assembleEvidence(raw, rawBytes, metadata) {
  validateMetadata(metadata);
  requireCondition(
    raw.schema === "stellar-8183/raw-testnet-capture/v1",
    "unsupported raw capture schema",
  );
  requireCondition(
    /^[0-9a-f]{40}$/.test(raw.source?.commitSha),
    "raw source commit is missing or malformed",
  );

  const paths = metadata.artifacts;
  requireDifferentPaths(paths.kernel_wasm, paths.kernel_rebuild_wasm, "kernel");
  requireDifferentPaths(
    paths.sla_hook_wasm,
    paths.sla_hook_rebuild_wasm,
    "SLA hook",
  );

  const kernel = digest(paths.kernel_wasm, "kernel Wasm");
  const kernelRebuild = digest(
    paths.kernel_rebuild_wasm,
    "kernel rebuild Wasm",
  );
  const kernelFetched = digest(
    paths.kernel_fetched_wasm,
    "fetched kernel Wasm",
  );
  const hook = digest(paths.sla_hook_wasm, "SLA-hook Wasm");
  const hookRebuild = digest(
    paths.sla_hook_rebuild_wasm,
    "SLA-hook rebuild Wasm",
  );
  const hookFetched = digest(
    paths.sla_hook_fetched_wasm,
    "fetched SLA-hook Wasm",
  );
  const sdk = digest(paths.sdk_tarball, "SDK tarball");
  const recording = digest(paths.demo_recording, "demo recording");
  const rawDigest = {
    bytes: rawBytes.length,
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
  };

  requireMatchingArtifacts(kernel, kernelRebuild, "kernel clean-build");
  requireMatchingArtifacts(kernel, kernelFetched, "kernel deployed");
  requireMatchingArtifacts(hook, hookRebuild, "SLA-hook clean-build");
  requireMatchingArtifacts(hook, hookFetched, "SLA-hook deployed");
  requireCondition(
    raw.source.kernelWasmSha256 === kernel.sha256,
    "raw kernel Wasm hash differs from the supplied artifact",
  );
  requireCondition(
    raw.source.hookWasmSha256 === hook.sha256,
    "raw SLA-hook Wasm hash differs from the supplied artifact",
  );

  const kernelDeployment = findExternal(raw, "deploy_kernel", "__constructor");
  const hookDeployment = findExternal(raw, "deploy_sla_hook", "__constructor");
  const hookAdmission = findExternal(raw, "admit_hook", "set_hook");
  const scenarios = Object.entries(SCENARIOS).map(([kind, expected]) => {
    const transactions = scenarioTransactions(raw, expected);
    const { jobId, snapshots } = scenarioSnapshots(raw, expected, transactions);
    return {
      id: expected.id,
      kind,
      job_id: jobId,
      description: expected.description,
      transactions: transactions.map((transaction) =>
        rawTransactionToManifest(
          transaction,
          transaction.method,
          transaction.method,
        ),
      ),
      job_snapshots: snapshots,
      final_state: expected.finalState,
      assertions: [...expected.assertions],
    };
  });

  const allRawTransactions = raw.transactions;
  const ledgers = allRawTransactions.map(({ ledger }) => ledger);
  requireCondition(ledgers.length > 0, "raw capture has no transactions");

  const evidence = {
    schema_version: "1.0.0",
    status: "deployment",
    generated_at: raw.generatedAt,
    release: {
      version: "0.1.0",
      tag: "v0.1.0",
      source_repository: REPOSITORY,
      source_commit: raw.source.commitSha,
    },
    network: {
      name: "testnet",
      passphrase: "Test SDF Network ; September 2015",
      rpc_url: RPC_URL,
      protocol_version: metadata.network.protocol_version,
      observed_at: metadata.network.observed_at,
      first_ledger: Math.min(...ledgers),
      last_ledger: Math.max(...ledgers),
    },
    build: {
      ...metadata.build,
      clean_builds_identical: true,
    },
    token: {
      asset_code: "USDC",
      issuer: TOKEN_ISSUER,
      contract_id: TOKEN_ID,
      decimals: 7,
    },
    contracts: {
      kernel: {
        contract_id: raw.contracts.kernel,
        local_wasm_sha256: kernel.sha256,
        fetched_wasm_sha256: kernelFetched.sha256,
        deployment_transaction: rawTransactionToManifest(
          kernelDeployment,
          "deploy_kernel",
          "__constructor",
        ),
        explorer_url:
          `https://stellar.expert/explorer/testnet/contract/` +
          raw.contracts.kernel,
        constructor: {
          admin: raw.identities.admin,
          token: TOKEN_ID,
        },
      },
      sla_hook: {
        contract_id: raw.contracts.hook,
        local_wasm_sha256: hook.sha256,
        fetched_wasm_sha256: hookFetched.sha256,
        deployment_transaction: rawTransactionToManifest(
          hookDeployment,
          "deploy_sla_hook",
          "__constructor",
        ),
        explorer_url:
          `https://stellar.expert/explorer/testnet/contract/` +
          raw.contracts.hook,
        constructor: {
          kernel: raw.contracts.kernel,
          review_secs: metadata.sla_review_secs,
        },
      },
      hook_admission_transaction: rawTransactionToManifest(
        hookAdmission,
        "admit_hook",
        "set_hook",
      ),
    },
    identities: { ...raw.identities },
    scenarios,
    artifacts: [
      makeArtifact(
        "kernel_wasm",
        paths.kernel_wasm,
        "application/wasm",
        kernel,
      ),
      makeArtifact(
        "sla_hook_wasm",
        paths.sla_hook_wasm,
        "application/wasm",
        hook,
      ),
      makeArtifact("sdk_tarball", paths.sdk_tarball, "application/gzip", sdk),
      makeArtifact(
        "raw_testnet_capture",
        "deployments/testnet.raw.json",
        "application/json",
        rawDigest,
      ),
      makeArtifact(
        "demo_recording",
        paths.demo_recording,
        "video/mp4",
        recording,
      ),
    ],
    attestation: {
      sep: "SEP-55",
      verified: false,
    },
    sdk: {
      package: "@trionlabs/stellar-8183",
      version: "0.1.0",
      tarball_sha256: sdk.sha256,
      provenance_verified: false,
    },
    demo: {
      recording_sha256: recording.sha256,
      published: false,
    },
    assertions: {
      all_local_tests_passed:
        metadata.operator_assertions.all_local_tests_passed,
      clean_builds_identical: true,
      deployed_wasm_matches: true,
      distinct_role_addresses: true,
      facilitator_is_transaction_source: true,
      role_auth_entries_verified: true,
      exact_balance_accounting: true,
      refund_non_hookable: true,
      no_secrets_in_artifacts:
        metadata.operator_assertions.no_secrets_in_artifacts,
      schema_valid: true,
    },
  };

  validateEvidenceSemantics(evidence, raw, rawBytes);
  return evidence;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const rawPath = resolve(args.raw);
  const outputPath = resolve(args.output);
  requireCondition(
    rawPath !== outputPath,
    "raw input and output paths must differ",
  );
  requireCondition(
    resolve(args.metadata) !== outputPath,
    "metadata input and output paths must differ",
  );
  requireCondition(
    rawPath === resolve("deployments/testnet.raw.json"),
    "raw capture must be staged at deployments/testnet.raw.json",
  );
  try {
    statSync(outputPath);
    fail(`output already exists: ${args.output}`);
  } catch (cause) {
    if (cause.code !== "ENOENT") {
      throw cause;
    }
  }

  const rawBytes = readFileSync(rawPath);
  const raw = JSON.parse(rawBytes.toString("utf8"));
  const evidence = assembleEvidence(
    raw,
    rawBytes,
    readJson(resolve(args.metadata), "metadata"),
  );
  writeFileSync(outputPath, canonicalJson(evidence), {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `Wrote deterministic deployment evidence to ${args.output}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
