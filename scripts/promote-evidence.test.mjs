import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const SCRIPT = fileURLToPath(
  new URL("./promote-evidence.mjs", import.meta.url),
);
const KERNEL_SHA = "a".repeat(64);
const HOOK_SHA = "b".repeat(64);
const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "promote-evidence-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deploymentEvidence() {
  return {
    schema_version: "1.0.0",
    status: "deployment",
    generated_at: "2026-01-01T00:00:00.000Z",
    release: {
      version: "0.1.0",
      tag: "v0.1.0",
      source_repository: "https://github.com/trionlabs/stellar-8183",
      source_commit: "c".repeat(40),
    },
    contracts: {
      kernel: { local_wasm_sha256: KERNEL_SHA },
      sla_hook: { local_wasm_sha256: HOOK_SHA },
    },
    attestation: { sep: "SEP-55", verified: false },
    sdk: {
      package: "@trionlabs/stellar-8183",
      version: "0.1.0",
      provenance_verified: false,
    },
    demo: { published: false },
  };
}

function promotionArguments(input, output) {
  return [
    SCRIPT,
    "--input",
    input,
    "--output",
    output,
    "--generated-at",
    "2026-01-02T03:04:05.000Z",
    "--release-url",
    "https://github.com/trionlabs/stellar-8183/releases/tag/v0.1.0",
    "--kernel-attestation-url",
    `https://api.github.com/repos/trionlabs/stellar-8183/attestations/sha256:${KERNEL_SHA}`,
    "--sla-hook-attestation-url",
    `https://api.github.com/repos/trionlabs/stellar-8183/attestations/sha256:${HOOK_SHA}`,
    "--npm-url",
    "https://www.npmjs.com/package/@trionlabs/stellar-8183/v/0.1.0",
    "--recording-url",
    "https://github.com/trionlabs/stellar-8183/releases/download/v0.1.0/demo.mp4",
  ];
}

function runPromotion(evidence, mutateArguments) {
  const directory = temporaryDirectory();
  const input = join(directory, "deployment.json");
  const output = join(directory, "verified.json");
  writeFileSync(input, `${JSON.stringify(evidence, null, 2)}\n`);
  const arguments_ = promotionArguments(input, output);
  mutateArguments?.(arguments_);
  const result = spawnSync(process.execPath, arguments_, {
    encoding: "utf8",
  });
  return { input, output, result };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("promotes only verified publication fields without mutating input", () => {
  const original = deploymentEvidence();
  const { input, output, result } = runPromotion(original);
  assert.equal(result.status, 0, result.stderr);

  const inputAfter = JSON.parse(readFileSync(input, "utf8"));
  const promoted = JSON.parse(readFileSync(output, "utf8"));
  assert.deepEqual(inputAfter, original);
  assert.equal(promoted.status, "verified");
  assert.equal(promoted.generated_at, "2026-01-02T03:04:05.000Z");
  assert.equal(promoted.attestation.verified, true);
  assert.equal(promoted.sdk.provenance_verified, true);
  assert.equal(promoted.demo.published, true);
  assert.equal(
    promoted.release.release_url,
    "https://github.com/trionlabs/stellar-8183/releases/tag/v0.1.0",
  );
});

test("emits byte-identical output for identical explicit inputs", () => {
  const evidence = deploymentEvidence();
  const first = runPromotion(evidence);
  const second = runPromotion(evidence);
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(
    readFileSync(first.output, "utf8"),
    readFileSync(second.output, "utf8"),
  );
});

test("rejects a deployment manifest with pre-populated publication data", () => {
  const evidence = deploymentEvidence();
  evidence.release.release_url =
    "https://github.com/trionlabs/stellar-8183/releases/tag/v0.1.0";
  const { result } = runPromotion(evidence);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be absent from deployment evidence/);
});

test("rejects a recording that is not an asset on the tagged release", () => {
  const { result } = runPromotion(deploymentEvidence(), (arguments_) => {
    arguments_[arguments_.indexOf("--recording-url") + 1] =
      "https://example.com/demo.mp4";
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must identify an asset on the v0\.1\.0/);
});

test("refuses to overwrite an existing output", () => {
  const directory = temporaryDirectory();
  const input = join(directory, "deployment.json");
  const output = join(directory, "verified.json");
  writeFileSync(input, `${JSON.stringify(deploymentEvidence(), null, 2)}\n`);
  writeFileSync(output, "do not replace\n");

  const result = spawnSync(
    process.execPath,
    promotionArguments(input, output),
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(output, "utf8"), "do not replace\n");
});
