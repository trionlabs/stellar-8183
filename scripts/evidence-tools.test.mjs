import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { assembleEvidence, canonicalJson } from "./assemble-evidence.mjs";
import { normalizeCreatedAt } from "./capture-deployment-transactions.mjs";
import { SCENARIOS, validateEvidenceSemantics } from "./validate-evidence.mjs";

const ASSEMBLER = fileURLToPath(
  new URL("./assemble-evidence.mjs", import.meta.url),
);
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const identities = {
  admin: `G${"A".repeat(55)}`,
  client: `G${"B".repeat(55)}`,
  provider: `G${"C".repeat(55)}`,
  evaluator: `G${"D".repeat(55)}`,
  facilitator: `G${"E".repeat(55)}`,
};
const kernel = `C${"F".repeat(55)}`;
const hook = `C${"G".repeat(55)}`;
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "evidence-tools-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hex(counter) {
  return counter.toString(16).padStart(64, "0");
}

function expectedAuthorizers(kind, step, occurrence) {
  if (step === "claim_refund") return [];
  if (["create_job", "set_provider", "fund"].includes(step)) {
    return [identities.client];
  }
  if (step === "submit") return [identities.provider];
  if (["complete"].includes(step)) return [identities.evaluator];
  if (step === "reject") {
    return [
      kind === "open_rejection" ? identities.client : identities.evaluator,
    ];
  }
  if (step === "set_budget") {
    return kind === "completion" && occurrence === 0
      ? [identities.client]
      : [identities.provider];
  }
  throw new Error(`unknown step ${step}`);
}

function eventNames(kind, step) {
  if (step === "reject") {
    return kind === "open_rejection"
      ? ["job_rejected"]
      : ["job_rejected", "refunded"];
  }
  return (
    {
      create_job: ["job_created"],
      set_provider: ["provider_set"],
      set_budget: ["budget_set"],
      fund: ["job_funded"],
      submit: ["job_submitted"],
      complete: ["job_completed", "payment_released"],
      claim_refund: ["job_expired", "refunded"],
    }[step] ?? []
  );
}

function deltas(kind, step) {
  const values = {
    [identities.client]: 0n,
    [identities.provider]: 0n,
    [identities.evaluator]: 0n,
    [kernel]: 0n,
  };
  if (step === "fund") {
    values[identities.client] = -10_000_000n;
    values[kernel] = 10_000_000n;
  } else if (step === "complete") {
    values[identities.provider] = 10_000_000n;
    values[kernel] = -10_000_000n;
  } else if (
    step === "claim_refund" ||
    (step === "reject" && kind !== "open_rejection")
  ) {
    values[identities.client] = 10_000_000n;
    values[kernel] = -10_000_000n;
  }
  return values;
}

function fixture() {
  const directory = temporaryDirectory();
  let transactionCounter = 1;
  let ledger = 1000;
  const transactions = [];
  const jobs = [];
  const balances = [];
  const kernelBytes = Buffer.from("kernel wasm fixture");
  const hookBytes = Buffer.from("hook wasm fixture");

  function transaction({
    label,
    method,
    source,
    contractId,
    authorizers = [],
    events = [],
    balanceChanges = [],
  }) {
    const createdAt = 1_767_225_600 + transactionCounter;
    const item = {
      label,
      method,
      hash: hex(transactionCounter),
      explorerUrl:
        "https://stellar.expert/explorer/testnet/tx/" + hex(transactionCounter),
      ledger: ledger++,
      createdAt,
      closedAt: new Date(createdAt * 1000).toISOString(),
      fee: "150",
      minResourceFee: "50",
      resources: {
        instructions: 1000 + transactionCounter,
        readBytes: 100,
        writeBytes: 50,
        readOnlyEntries: 2,
        readWriteEntries: 2,
        declaredResourceFee: "50",
        inclusionFee: "100",
        totalFee: "150",
      },
      source,
      contractId,
      authorizers,
      argumentsSha256: hex(1000 + transactionCounter),
      envelopeSha256: hex(2000 + transactionCounter),
      resultXdr: "AAAA",
      contractEventsXdr: events.map(() => "AAAA"),
      decodedEvents: events.map((name) => ({
        contractId: kernel,
        name,
        decoded: { fixture: true },
      })),
      balanceChanges,
    };
    transactionCounter += 1;
    transactions.push(item);
    return item;
  }

  transaction({
    label: "deploy_kernel",
    method: "__constructor",
    source: identities.admin,
    contractId: kernel,
  });
  transaction({
    label: "deploy_sla_hook",
    method: "__constructor",
    source: identities.admin,
    contractId: hook,
  });
  transaction({
    label: "admit_hook",
    method: "set_hook",
    source: identities.admin,
    contractId: kernel,
    events: ["hook_set"],
  });

  let jobId = 1;
  const suffixes = {
    completion: [
      "create_job",
      "set_provider",
      "client_budget",
      "provider_budget",
      "fund",
      "submit",
      "complete",
    ],
    refund: [
      "create_job",
      "set_provider",
      "provider_budget",
      "fund",
      "claim_refund",
    ],
    open_rejection: ["create_job", "reject"],
    evaluator_rejection: [
      "create_job",
      "set_provider",
      "provider_budget",
      "fund",
      "reject",
    ],
  };
  for (const [kind, expected] of Object.entries(SCENARIOS)) {
    const beforeScenario = {
      [identities.client]: 100_000_000n,
      [identities.provider]: 0n,
      [identities.evaluator]: 0n,
      [kernel]: 0n,
    };
    const running = { ...beforeScenario };
    const expiry = 1_767_229_999 + jobId;
    let setBudgetOccurrence = 0;
    for (const [index, step] of expected.steps.entries()) {
      const stepDeltas = deltas(kind, step);
      const balanceChanges = Object.entries(stepDeltas).map(
        ([address, delta]) => {
          const before = running[address];
          const after = before + delta;
          running[address] = after;
          return {
            label:
              address === identities.client
                ? "client"
                : address === identities.provider
                  ? "provider"
                  : address === identities.evaluator
                    ? "evaluator"
                    : "escrow",
            address,
            before: before.toString(),
            after: after.toString(),
            delta: delta.toString(),
          };
        },
      );
      transaction({
        label: `${expected.prefix}.${suffixes[kind][index]}`,
        method: step,
        source: identities.facilitator,
        contractId: kernel,
        authorizers: expectedAuthorizers(
          kind,
          step,
          step === "set_budget" ? setBudgetOccurrence++ : 0,
        ),
        events: eventNames(kind, step),
        balanceChanges,
      });

      const budget =
        kind === "open_rejection" ||
        step === "create_job" ||
        step === "set_provider"
          ? 0n
          : kind === "completion" && step === "set_budget" && index === 2
            ? 9_999_999n
            : 10_000_000n;
      const provider =
        step === "create_job" || kind === "open_rejection"
          ? undefined
          : identities.provider;
      const snapshot = {
        label: `${expected.prefix}.snapshot_${index}`,
        id: String(jobId),
        state: expected.states[index],
        client: identities.client,
        provider,
        evaluator: identities.evaluator,
        descriptionSha256: hash(
          Buffer.from(`fixture description ${jobId}`, "utf8"),
        ),
        budget: budget.toString(),
        expiresAt: String(expiry),
        hook,
      };
      if (kind === "completion" && ["submit", "complete"].includes(step)) {
        snapshot.workHash = "a".repeat(64);
      }
      if (
        (kind === "completion" && step === "complete") ||
        (["open_rejection", "evaluator_rejection"].includes(kind) &&
          step === "reject")
      ) {
        snapshot.decision = "b".repeat(64);
      }
      jobs.push(snapshot);
    }
    for (const [address, before] of Object.entries(beforeScenario)) {
      balances.push({
        label:
          `${expected.prefix}.` +
          (address === identities.client
            ? "client"
            : address === identities.provider
              ? "provider"
              : address === identities.evaluator
                ? "evaluator"
                : "escrow"),
        address,
        before: before.toString(),
        after: running[address].toString(),
        delta: (running[address] - before).toString(),
      });
    }
    jobId += 1;
  }

  const artifactDirectory = join(directory, "artifacts");
  mkdirSync(artifactDirectory);
  const files = {
    kernel_wasm: join(artifactDirectory, "kernel.wasm"),
    kernel_rebuild_wasm: join(artifactDirectory, "kernel-rebuild.wasm"),
    kernel_fetched_wasm: join(artifactDirectory, "kernel-fetched.wasm"),
    sla_hook_wasm: join(artifactDirectory, "hook.wasm"),
    sla_hook_rebuild_wasm: join(artifactDirectory, "hook-rebuild.wasm"),
    sla_hook_fetched_wasm: join(artifactDirectory, "hook-fetched.wasm"),
    sdk_tarball: join(artifactDirectory, "sdk.tgz"),
    demo_recording: join(artifactDirectory, "demo.mp4"),
  };
  for (const path of [
    files.kernel_wasm,
    files.kernel_rebuild_wasm,
    files.kernel_fetched_wasm,
  ]) {
    writeFileSync(path, kernelBytes);
  }
  for (const path of [
    files.sla_hook_wasm,
    files.sla_hook_rebuild_wasm,
    files.sla_hook_fetched_wasm,
  ]) {
    writeFileSync(path, hookBytes);
  }
  writeFileSync(files.sdk_tarball, "sdk fixture");
  writeFileSync(files.demo_recording, "recording fixture");

  const raw = {
    schema: "stellar-8183/raw-testnet-capture/v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    network: {
      name: "testnet",
      passphrase: "Test SDF Network ; September 2015",
    },
    contracts: { kernel, token: TOKEN, hook, hookReviewSeconds: 30 },
    token: { contractId: TOKEN, decimals: 7 },
    source: {
      commitSha: "c".repeat(40),
      kernelWasmSha256: hash(kernelBytes),
      hookWasmSha256: hash(hookBytes),
    },
    identities,
    transactions,
    jobs,
    balances,
  };
  const rawBytes = Buffer.from(canonicalJson(raw));
  const metadata = {
    network: {
      protocol_version: 27,
      observed_at: "2026-01-01T00:00:01.000Z",
    },
    build: {
      rustc: "1.96.0",
      stellar_cli: "stellar 27.0.0",
      soroban_sdk: "27.0.3",
      node: "v22.22.0",
      pnpm: "11.9.0",
      stellar_sdk: "16.2.0",
      source_repo_metadata: "github:trionlabs/stellar-8183",
    },
    sla_review_secs: 30,
    artifacts: files,
    operator_assertions: {
      all_local_tests_passed: true,
      no_secrets_in_artifacts: true,
    },
  };
  return { directory, raw, rawBytes, metadata };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("deployment capture normalizes RPC string close timestamps", () => {
  assert.equal(normalizeCreatedAt("1767225600"), 1_767_225_600);
  assert.throws(
    () => normalizeCreatedAt("1767225600.5"),
    /invalid transaction close timestamp/,
  );
  assert.throws(
    () => normalizeCreatedAt("9007199254740992"),
    /invalid transaction close timestamp/,
  );
});

test("assembles canonical, semantically bound deployment evidence", () => {
  const { raw, rawBytes, metadata } = fixture();
  const first = assembleEvidence(raw, rawBytes, metadata);
  const second = assembleEvidence(raw, rawBytes, metadata);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(validateEvidenceSemantics(first, raw, rawBytes), true);
  assert.equal(first.scenarios.length, 4);
  assert.equal(first.artifacts[3].sha256, hash(rawBytes));
  if (process.env.EVIDENCE_TEST_OUTPUT !== undefined) {
    writeFileSync(process.env.EVIDENCE_TEST_OUTPUT, canonicalJson(first));
    writeFileSync(`${process.env.EVIDENCE_TEST_OUTPUT}.raw.json`, rawBytes);
  }
});

test("semantic validation rejects an incorrect role authorizer", () => {
  const { raw, rawBytes, metadata } = fixture();
  const evidence = assembleEvidence(raw, rawBytes, metadata);
  evidence.scenarios[0].transactions[0].authorizers = [identities.provider];
  assert.throws(
    () => validateEvidenceSemantics(evidence, raw, rawBytes),
    /authorizers/,
  );
});

test("semantic validation rejects inconsistent balance arithmetic", () => {
  const { raw, rawBytes, metadata } = fixture();
  const evidence = assembleEvidence(raw, rawBytes, metadata);
  evidence.scenarios[0].transactions[4].balance_changes[0].delta_base_units =
    "-9999999";
  assert.throws(
    () => validateEvidenceSemantics(evidence, raw, rawBytes),
    /raw|balance/i,
  );
});

test("semantic validation rejects non-whitelisted raw capture fields", () => {
  const { raw, rawBytes, metadata } = fixture();
  const evidence = assembleEvidence(raw, rawBytes, metadata);
  raw.secret = "must never survive release capture";
  assert.throws(
    () => validateEvidenceSemantics(evidence, raw, rawBytes),
    /whitelisted fields/,
  );
});

test("assembly rejects a non-identical clean rebuild", () => {
  const { raw, rawBytes, metadata } = fixture();
  writeFileSync(metadata.artifacts.kernel_rebuild_wasm, "different");
  assert.throws(
    () => assembleEvidence(raw, rawBytes, metadata),
    /not byte-identical/,
  );
});

test("CLI refuses to overwrite an existing manifest", () => {
  const { directory, raw, metadata } = fixture();
  const deployments = join(directory, "deployments");
  mkdirSync(deployments);
  const rawPath = join(deployments, "testnet.raw.json");
  const metadataPath = join(directory, "metadata.json");
  const outputPath = join(deployments, "testnet.json");
  writeFileSync(rawPath, canonicalJson(raw));
  writeFileSync(metadataPath, canonicalJson(metadata));

  const arguments_ = [
    ASSEMBLER,
    "--raw",
    "deployments/testnet.raw.json",
    "--metadata",
    "metadata.json",
    "--output",
    "deployments/testnet.json",
  ];
  const first = spawnSync(process.execPath, arguments_, {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(outputPath, "utf8");
  const second = spawnSync(process.execPath, arguments_, {
    cwd: directory,
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.equal(readFileSync(outputPath, "utf8"), original);
});
