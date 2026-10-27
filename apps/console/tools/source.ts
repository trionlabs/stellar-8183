import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const inputs = [
  "contracts",
  ".cargo",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "scripts/release-build.sh",
  "scripts/verify-release.sh",
];

export async function assertBuildSource(
  root: string,
  commit: string,
): Promise<void> {
  await execute("git", ["diff", "--exit-code", "HEAD", "--", ...inputs], {
    cwd: root,
  });
  // Include ignored files: an ignored build.rs or Cargo config can change Wasm.
  const untracked = await execute(
    "git",
    ["ls-files", "--others", "--", ...inputs],
    { cwd: root },
  );
  if (untracked.stdout.trim())
    throw new Error(
      "Untracked contract or Cargo build inputs are not allowed.",
    );
  const head = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  if (head.stdout.trim() !== commit)
    throw new Error("Source commit changed during deployment.");
}
