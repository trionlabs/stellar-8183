#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_REPOSITORY = "https://github.com/trionlabs/stellar-8183";
const EXPECTED_PACKAGE = "@trionlabs/stellar-8183";
const EXPECTED_VERSION = "0.1.0";
const EXPECTED_TAG = "v0.1.0";

function fail(message) {
  throw new Error(`evidence promotion refused: ${message}`);
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

  const allowed = new Set([
    "--input",
    "--output",
    "--generated-at",
    "--release-url",
    "--kernel-attestation-url",
    "--sla-hook-attestation-url",
    "--npm-url",
    "--recording-url",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) {
      fail(`unknown argument ${name}`);
    }
  }
  for (const name of allowed) {
    if (!values.has(name)) {
      fail(`missing argument ${name}`);
    }
  }

  return Object.fromEntries(
    [...values].map(([name, value]) => [
      name.slice(2).replaceAll("-", "_"),
      value,
    ]),
  );
}

function assertHttps(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    fail(`${label} must be an HTTPS URL without credentials`);
  }
}

function assertAbsent(object, property, label) {
  if (Object.hasOwn(object, property)) {
    fail(`${label}.${property} must be absent from deployment evidence`);
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

const args = parseArguments(process.argv.slice(2));
const inputPath = resolve(args.input);
const outputPath = resolve(args.output);
if (inputPath === outputPath) {
  fail("input and output paths must differ");
}

let evidence;
try {
  evidence = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (cause) {
  fail(`cannot parse input JSON: ${cause.message}`);
}

if (evidence.schema_version !== "1.0.0") {
  fail("unsupported schema_version");
}
if (evidence.status !== "deployment") {
  fail("input status must be deployment");
}
if (
  evidence.release?.source_repository !== EXPECTED_REPOSITORY ||
  evidence.release?.version !== EXPECTED_VERSION ||
  evidence.release?.tag !== EXPECTED_TAG
) {
  fail("release identity does not match version 0.1.0");
}
if (
  evidence.sdk?.package !== EXPECTED_PACKAGE ||
  evidence.sdk?.version !== EXPECTED_VERSION
) {
  fail("SDK identity does not match version 0.1.0");
}
if (evidence.attestation?.verified !== false) {
  fail("deployment attestation.verified must be false");
}
if (evidence.sdk?.provenance_verified !== false) {
  fail("deployment sdk.provenance_verified must be false");
}
if (evidence.demo?.published !== false) {
  fail("deployment demo.published must be false");
}

assertAbsent(evidence.release, "release_url", "release");
assertAbsent(evidence.attestation, "kernel_url", "attestation");
assertAbsent(evidence.attestation, "sla_hook_url", "attestation");
assertAbsent(evidence.sdk, "registry_url", "sdk");
assertAbsent(evidence.demo, "recording_url", "demo");

if (!/^[0-9a-f]{64}$/.test(evidence.contracts?.kernel?.local_wasm_sha256)) {
  fail("kernel local Wasm SHA-256 is missing or malformed");
}
if (!/^[0-9a-f]{64}$/.test(evidence.contracts?.sla_hook?.local_wasm_sha256)) {
  fail("SLA-hook local Wasm SHA-256 is missing or malformed");
}

for (const [value, label] of [
  [args.release_url, "release URL"],
  [args.kernel_attestation_url, "kernel attestation URL"],
  [args.sla_hook_attestation_url, "SLA-hook attestation URL"],
  [args.npm_url, "npm URL"],
  [args.recording_url, "recording URL"],
]) {
  assertHttps(value, label);
}

const expectedReleaseUrl = `${EXPECTED_REPOSITORY}/releases/tag/${EXPECTED_TAG}`;
const expectedKernelAttestationUrl =
  `https://api.github.com/repos/trionlabs/stellar-8183/attestations/` +
  `sha256:${evidence.contracts.kernel.local_wasm_sha256}`;
const expectedSlaHookAttestationUrl =
  `https://api.github.com/repos/trionlabs/stellar-8183/attestations/` +
  `sha256:${evidence.contracts.sla_hook.local_wasm_sha256}`;
const expectedNpmUrl = `https://www.npmjs.com/package/${EXPECTED_PACKAGE}/v/${EXPECTED_VERSION}`;
const expectedRecordingPrefix = `${EXPECTED_REPOSITORY}/releases/download/${EXPECTED_TAG}/`;

for (const [actual, expected, label] of [
  [args.release_url, expectedReleaseUrl, "release URL"],
  [
    args.kernel_attestation_url,
    expectedKernelAttestationUrl,
    "kernel attestation URL",
  ],
  [
    args.sla_hook_attestation_url,
    expectedSlaHookAttestationUrl,
    "SLA-hook attestation URL",
  ],
  [args.npm_url, expectedNpmUrl, "npm URL"],
]) {
  if (actual !== expected) {
    fail(`${label} is not the deterministic URL for this deployment`);
  }
}
if (!args.recording_url.startsWith(expectedRecordingPrefix)) {
  fail("recording URL must identify an asset on the v0.1.0 GitHub release");
}

const generatedAt = new Date(args.generated_at);
if (
  Number.isNaN(generatedAt.getTime()) ||
  generatedAt.toISOString() !== args.generated_at
) {
  fail("generated-at must be a canonical UTC ISO-8601 timestamp");
}

evidence.status = "verified";
evidence.generated_at = args.generated_at;
evidence.release.release_url = args.release_url;
evidence.attestation.kernel_url = args.kernel_attestation_url;
evidence.attestation.sla_hook_url = args.sla_hook_attestation_url;
evidence.attestation.verified = true;
evidence.sdk.registry_url = args.npm_url;
evidence.sdk.provenance_verified = true;
evidence.demo.recording_url = args.recording_url;
evidence.demo.published = true;

writeFileSync(outputPath, `${JSON.stringify(canonical(evidence), null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
