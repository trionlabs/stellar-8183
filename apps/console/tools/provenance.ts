import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CanaryEvidence } from "../src/canary.js";

const execute = promisify(execFile);

// Trust anchor for the independently rebuilt v0.1 contract profile. New contract
// inputs or compiler artifacts require a separately reviewed profile update.
export const PINNED_BUILD = {
  sourceCommit: "97363501078154c65179208985e56ebb3b326ec7",
  kernelWasmSha256:
    "c07d5528b42827ecdcfad7e798bc0d08cd7e1183343746a415b4cf8b7e7cfcad",
  hookWasmSha256:
    "14ef819cc362420d9ae543202774f094d794d4004889c86078e9a47cb7f94120",
  toolchain: {
    rustc: "rustc 1.96.0 (ac68faa20 2026-05-25)",
    stellarCli:
      "stellar 27.0.0 (5a7c5fe76530bf4248477ac812fc757146b98cc4)\nstellar-xdr 27.0.0 (5262803470be965e42f80023d12fba12808c774a)\nxdr (68fa1ac55692f68ad2a2ca549d0a283273554439)",
    pnpm: "pnpm@11.9.0",
    sorobanSdk: "27.0.3",
    stellarSdk: "16.2.0",
  },
  inputs: {
    "Cargo.lock": "100644 blob 1ea91408c17850b23ec2e04eff34bbc0c6c03c65",
    "Cargo.toml": "100644 blob 24e248333cb88a03462bafb2e12ce67b878afe94",
    contracts: "040000 tree 78fb2d13b495638b6bc75545ed59083231197676",
    "rust-toolchain.toml":
      "100644 blob cbda80abb31705e571b5bef97a3cf2f8141a4a63",
    "scripts/release-build.sh":
      "100755 blob 9db46500ffe55ae9cb3357f6b736da11be062a89",
    "scripts/verify-release.sh":
      "100755 blob c731625fd5366ac18498fa21e2bdd8e2f46f83d1",
  },
} as const;

type BuildEvidence = Pick<
  CanaryEvidence,
  "sourceCommit" | "kernelWasmSha256" | "hookWasmSha256" | "toolchain"
>;

export async function verifyBuildProvenance(
  evidence: BuildEvidence,
  repositoryRoot: string,
): Promise<void> {
  if (
    evidence.kernelWasmSha256 !== PINNED_BUILD.kernelWasmSha256 ||
    evidence.hookWasmSha256 !== PINNED_BUILD.hookWasmSha256
  )
    throw new Error(
      "Wasm hashes do not match the reviewed v0.1 build profile.",
    );
  for (const name of Object.keys(
    PINNED_BUILD.toolchain,
  ) as (keyof typeof PINNED_BUILD.toolchain)[])
    if (evidence.toolchain[name] !== PINNED_BUILD.toolchain[name])
      throw new Error(
        "Toolchain does not match the reviewed v0.1 build profile.",
      );
  const nodeVersion = /^v([0-9]+)\.[0-9]+\.[0-9]+$/.exec(
    evidence.toolchain.node,
  );
  if (!nodeVersion || Number(nodeVersion[1]) < 22)
    throw new Error(
      "Evidence tooling requires a supported Node version (22 or newer).",
    );
  if (!/^[a-f0-9]{40}$/.test(evidence.sourceCommit))
    throw new Error("Invalid source commit in build provenance.");
  if (evidence.sourceCommit === PINNED_BUILD.sourceCommit) return;

  const git = async (args: string[]) => {
    try {
      return (
        await execute("git", args, {
          cwd: repositoryRoot,
          timeout: 10_000,
          maxBuffer: 100_000,
        })
      ).stdout;
    } catch {
      throw new Error(
        "Declared source commit is unavailable locally for build provenance verification.",
      );
    }
  };
  const commit = (
    await git(["rev-parse", "--verify", `${evidence.sourceCommit}^{commit}`])
  ).trim();
  if (commit !== evidence.sourceCommit)
    throw new Error("Declared source is not a commit.");
  const tree = await git([
    "ls-tree",
    "-z",
    commit,
    "--",
    ...Object.keys(PINNED_BUILD.inputs),
    ".cargo",
  ]);
  const actual: Record<string, string> = {};
  for (const row of tree.split("\0").filter(Boolean)) {
    const separator = row.indexOf("\t");
    if (separator < 0)
      throw new Error("Invalid source tree in build provenance.");
    actual[row.slice(separator + 1)] = row.slice(0, separator);
  }
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(PINNED_BUILD.inputs).sort())
  )
    throw new Error(
      "Source build inputs differ from the reviewed v0.1 build profile.",
    );
}
