import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/trionlabs/stellar-8183.git";
const run = async (command, args, cwd = root) => (await execute(command, args, { cwd, maxBuffer: 2_000_000, timeout: 120_000 })).stdout.trim();
const sourceCommit = await run("git", ["rev-parse", "HEAD"]);
if (await run("git", ["status", "--porcelain"])) throw new Error("Commit the reviewed source before publishing the Console.");
if (await run("git", ["remote", "get-url", "origin"]) !== repository) throw new Error("Unexpected deployment repository.");
const branch = await run("git", ["branch", "--show-current"]);
if (branch !== "feat/agent-commerce-console") throw new Error("Publish from the reviewed Console branch.");
const remoteSource = await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
if (!remoteSource.startsWith(`${sourceCommit}\t`)) throw new Error("Push the exact source commit before publishing.");
await run("corepack", ["pnpm@11.9.0", "console:build"]);
await run("gitleaks", ["dir", "apps/console/dist", "--config", ".gitleaks.toml", "--no-banner", "--redact"]);
await readFile(join(root, "apps/console/dist/index.html"));
if (await run("git", ["ls-remote", "--heads", "origin", "refs/heads/gh-pages"])) throw new Error("gh-pages already exists. This first-publication tool refuses to overwrite an existing website.");
try {
  await run("gh", ["api", "repos/trionlabs/stellar-8183/pages"]);
  throw new Error("GitHub Pages is already configured. Refusing to replace it.");
} catch (error) {
  if (!String(error.stderr ?? "").includes("HTTP 404")) throw error;
}
const staging = await mkdtemp(join(tmpdir(), "stellar-8183-pages-"));
await cp(join(root, "apps/console/dist"), staging, { recursive: true });
await writeFile(join(staging, "build.json"), JSON.stringify({ project: "stellar-8183", sourceCommit, sourceBranch: "feat/agent-commerce-console", builtAt: new Date().toISOString(), network: "testnet-preview", independentPilotCompleted: false }, null, 2));
await run("git", ["init", "--initial-branch=gh-pages"], staging);
await run("git", ["remote", "add", "origin", repository], staging);
await run("git", ["add", "."], staging);
await run("git", ["commit", "-m", "build(console): publish static testnet preview"], staging);
await run("git", ["push", "origin", "gh-pages"], staging);
await run("gh", ["api", "repos/trionlabs/stellar-8183/pages", "--method", "POST", "-f", "source[branch]=gh-pages", "-f", "source[path]=/", "-f", "build_type=legacy"]);
console.log(JSON.stringify({ url: "https://trionlabs.github.io/stellar-8183/", sourceCommit, staticCommit: await run("git", ["rev-parse", "HEAD"], staging), staging }, null, 2));
