import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  canonicalJson,
  type CanonicalJsonValue,
} from "@trionlabs/stellar-8183";
import { parseCanaryEvidence } from "../src/canary.js";
import { digestText, parseReceipt } from "../src/receipt.js";
import { verifyBuildProvenance } from "../tools/provenance.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const evidence = async () =>
  parseCanaryEvidence(
    await readFile(
      resolve(root, "deployments/month-two/canary-evidence.json"),
      "utf8",
    ),
  );

it("accepts the reviewed source and current commits with byte-identical contract build inputs", async () => {
  const input = await evidence();
  await expect(verifyBuildProvenance(input, root)).resolves.toBeUndefined();
  const sourceCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await expect(
    verifyBuildProvenance({ ...input, sourceCommit }, root),
  ).resolves.toBeUndefined();
});

it("rejects a fabricated source commit before any network verification", async () => {
  await expect(
    verifyBuildProvenance(
      { ...(await evidence()), sourceCommit: "0".repeat(40) },
      root,
    ),
  ).rejects.toThrow("unavailable locally");
});

it("rejects a real unrelated commit even when its declared Wasm hashes are correct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "8183-wrong-source-"));
  try {
    const git = async (...args: string[]) =>
      (await execute("git", args, { cwd: dir })).stdout.trim();
    await git("init", "--quiet");
    await git(
      "-c",
      "user.name=Provenance test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: unrelated source",
    );
    const sourceCommit = await git("rev-parse", "HEAD");
    await expect(
      verifyBuildProvenance({ ...(await evidence()), sourceCommit }, dir),
    ).rejects.toThrow("build inputs differ");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["kernelWasmSha256", "hookWasmSha256"] as const)(
  "rejects substituted %s",
  async (name) => {
    await expect(
      verifyBuildProvenance(
        { ...(await evidence()), [name]: "ab".repeat(32) },
        root,
      ),
    ).rejects.toThrow("Wasm hashes");
  },
);

it("rejects a mismatched compiler identity or unsupported evidence runtime", async () => {
  const input = await evidence();
  await expect(
    verifyBuildProvenance(
      {
        ...input,
        toolchain: {
          ...input.toolchain,
          rustc: "rustc 1.96.0 (unreviewed compiler)",
        },
      },
      root,
    ),
  ).rejects.toThrow("Toolchain");
  await expect(
    verifyBuildProvenance(
      { ...input, toolchain: { ...input.toolchain, node: "v18.20.0" } },
      root,
    ),
  ).rejects.toThrow("supported Node");
});

it("rejects numeric receipt budgets even with a correct recomputed checksum", async () => {
  const input = await evidence();
  const file = structuredClone(input.receipts[0]!);
  const receipt: Record<string, CanonicalJsonValue> = {
    ...file.receipt,
    budget: Number(file.receipt.budget),
  } as unknown as Record<string, CanonicalJsonValue>;
  await expect(
    parseReceipt(
      JSON.stringify({
        receipt,
        sha256: await digestText(canonicalJson(receipt)),
      }),
    ),
  ).rejects.toThrow("Invalid receipt budget");
});
