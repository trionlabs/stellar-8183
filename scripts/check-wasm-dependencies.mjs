import { execFileSync } from "node:child_process";

const tree = execFileSync("cargo", [
  "tree", "--locked", "--target", "wasm32v1-none", "--edges", "normal,build",
  "--prefix", "none", "--format", "{p}",
], { encoding: "utf8" });

if (/^crypto-bigint v/m.test(tree)) {
  throw new Error("crypto-bigint reached the contract build graph. Revoke the host-only RUSTSEC-2026-0387 exception and review the dependency.");
}
console.log("Confirmed crypto-bigint is absent from the production Wasm dependency graph.");
