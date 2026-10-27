import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { assertBuildSource } from "../tools/source.js";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function checkout() {
  const root = await mkdtemp(join(tmpdir(), "8183-source-test-"));
  temporary.push(root);
  const git = async (...args: string[]) =>
    (await execute("git", args, { cwd: root })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Source test");
  await git("config", "user.email", "test@example.invalid");
  await mkdir(join(root, "contracts/commerce/src"), { recursive: true });
  await writeFile(
    join(root, "contracts/commerce/src/lib.rs"),
    "// pinned source\n",
  );
  await writeFile(join(root, ".gitignore"), "build.rs\n.cargo/\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "test: pin source");
  return { root, commit: await git("rev-parse", "HEAD"), git };
}
it("rejects ignored Cargo build scripts and configuration outside the commit", async () => {
  const { root, commit } = await checkout();
  await expect(assertBuildSource(root, commit)).resolves.toBeUndefined();
  await writeFile(join(root, "contracts/commerce/build.rs"), "fn main() {}\n");
  await expect(assertBuildSource(root, commit)).rejects.toThrow("Untracked");
  await rm(join(root, "contracts/commerce/build.rs"));
  await mkdir(join(root, ".cargo"));
  await writeFile(join(root, ".cargo/config.toml"), "[build]\n");
  await expect(assertBuildSource(root, commit)).rejects.toThrow("Untracked");
});
it("rejects modified tracked source and changed commits", async () => {
  const { root, commit, git } = await checkout();
  await writeFile(
    join(root, "contracts/commerce/src/lib.rs"),
    "// changed source\n",
  );
  await expect(assertBuildSource(root, commit)).rejects.toThrow();
  await git("add", ".");
  await git("commit", "--quiet", "-m", "test: change source");
  await expect(assertBuildSource(root, commit)).rejects.toThrow(
    "Source commit changed",
  );
});
