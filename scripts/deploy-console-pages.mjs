import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/trionlabs/stellar-8183.git";
const repositorySlug = "trionlabs/stellar-8183";
const sourceBranch = "feat/agent-commerce-console";
const pagesUrl = "https://trionlabs.github.io/stellar-8183/";
const prepareOnly = process.argv.includes("--prepare-only");

if (
  process.argv.slice(2).some((value) => value !== "--prepare-only") ||
  process.argv.length > 3
)
  throw new Error(
    "Usage: node scripts/deploy-console-pages.mjs [--prepare-only]",
  );

const run = async (command, args, cwd = root, timeout = 1_200_000) =>
  (
    await execute(command, args, {
      cwd,
      maxBuffer: 10_000_000,
      timeout,
    })
  ).stdout.trim();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function files(directory, base = directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await files(path, base)));
    else if (entry.isFile()) output.push(relative(base, path));
    else throw new Error(`Refusing unsupported deployment entry: ${path}`);
  }
  return output.sort();
}

async function fileHashes(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await files(directory))
        .filter(
          (path) =>
            path !== "build.json" &&
            path !== ".git" &&
            !path.startsWith(".git/"),
        )
        .map(async (path) => [
          path,
          sha256(await readFile(join(directory, path))),
        ]),
    ),
  );
}

const sourceCommit = await run("git", ["rev-parse", "HEAD"]);
if (await run("git", ["status", "--porcelain"]))
  throw new Error("Commit the reviewed source before publishing the Console.");
if ((await run("git", ["remote", "get-url", "origin"])) !== repository)
  throw new Error("Unexpected deployment repository.");
if ((await run("git", ["branch", "--show-current"])) !== sourceBranch)
  throw new Error("Publish from the reviewed Console branch.");
const remoteSource = await run("git", [
  "ls-remote",
  "--heads",
  "origin",
  `refs/heads/${sourceBranch}`,
]);
if (!remoteSource.startsWith(`${sourceCommit}\t`))
  throw new Error("Push the exact source commit before publishing.");

const pages = JSON.parse(
  await run("gh", ["api", `repos/${repositorySlug}/pages`]),
);
if (
  pages.html_url !== pagesUrl ||
  pages.build_type !== "legacy" ||
  pages.source?.branch !== "gh-pages" ||
  pages.source?.path !== "/" ||
  pages.https_enforced !== true
)
  throw new Error(
    "GitHub Pages does not match the reviewed HTTPS gh-pages configuration.",
  );

await run("git", ["fetch", "origin", "gh-pages"]);
const currentBuild = JSON.parse(
  await run("git", ["show", "origin/gh-pages:build.json"]),
);
if (
  currentBuild.project !== "stellar-8183" ||
  currentBuild.sourceBranch !== sourceBranch ||
  !/^[a-f0-9]{40}$/.test(currentBuild.sourceCommit ?? "")
)
  throw new Error(
    "The published build metadata is missing or belongs to another site.",
  );
try {
  await run("git", [
    "merge-base",
    "--is-ancestor",
    currentBuild.sourceCommit,
    sourceCommit,
  ]);
} catch {
  throw new Error(
    "Refusing to publish a source rollback or unrelated history.",
  );
}

const runs = JSON.parse(
  await run("gh", [
    "run",
    "list",
    "--repo",
    repositorySlug,
    "--commit",
    sourceCommit,
    "--workflow",
    "CI",
    "--limit",
    "10",
    "--json",
    "conclusion,headSha,status,url",
  ]),
);
const ci = runs.find(
  (run) =>
    run.headSha === sourceCommit &&
    run.status === "completed" &&
    run.conclusion === "success",
);
if (!ci)
  throw new Error(
    "The exact source commit needs a successful CI run before publication.",
  );

await run("corepack", ["pnpm@11.9.0", "console:build"]);
await run("gitleaks", [
  "dir",
  "apps/console/dist",
  "--config",
  ".gitleaks.toml",
  "--no-banner",
  "--redact",
]);

const staging = await mkdtemp(join(tmpdir(), "stellar-8183-pages-"));
await run("git", [
  "clone",
  "--depth",
  "1",
  "--branch",
  "gh-pages",
  repository,
  staging,
]);
for (const entry of await readdir(staging))
  if (entry !== ".git")
    await rm(join(staging, entry), { recursive: true, force: true });
await cp(join(root, "apps/console/dist"), staging, { recursive: true });
await writeFile(join(staging, ".nojekyll"), "");
const manifest = {
  project: "stellar-8183",
  sourceCommit,
  sourceBranch,
  publishedAt: new Date().toISOString(),
  network: "testnet-preview",
  mainnetCanaryImportSupported: true,
  independentPilotCompleted: false,
  ciRun: ci.url,
  files: await fileHashes(staging),
};
await writeFile(
  join(staging, "build.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await run("git", ["add", "--all"], staging);
await run(
  "git",
  ["commit", "-m", `build(console): publish ${sourceCommit.slice(0, 7)}`],
  staging,
);
const staticCommit = await run("git", ["rev-parse", "HEAD"], staging);

if (prepareOnly) {
  console.log(
    JSON.stringify(
      {
        status: "PAGES_BUILD_PREPARED",
        sourceCommit,
        staticCommit,
        staging,
        manifest,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

await run("git", ["push", "origin", "gh-pages"], staging);
let published;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const response = await fetch(
      `${pagesUrl}build.json?source=${sourceCommit}&attempt=${attempt}`,
      { cache: "no-store", signal: AbortSignal.timeout(30_000) },
    );
    if (response.ok) {
      const candidate = await response.json();
      if (candidate.sourceCommit === sourceCommit) {
        published = candidate;
        break;
      }
    }
  } catch {
    // GitHub Pages may briefly return a stale response while publishing.
  }
  await new Promise((done) => setTimeout(done, 5_000));
}
if (!published)
  throw new Error(
    "GitHub Pages did not publish the reviewed build within five minutes.",
  );
if (JSON.stringify(published.files) !== JSON.stringify(manifest.files))
  throw new Error(
    "Published build metadata differs from the prepared manifest.",
  );
for (const [path, expected] of Object.entries(manifest.files)) {
  const response = await fetch(`${pagesUrl}${path}?source=${sourceCommit}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !response.ok ||
    sha256(Buffer.from(await response.arrayBuffer())) !== expected
  )
    throw new Error(`Published file verification failed: ${path}`);
}

console.log(
  JSON.stringify(
    {
      status: "PAGES_DEPLOYED_AND_VERIFIED",
      url: pagesUrl,
      sourceCommit,
      staticCommit,
      ciRun: ci.url,
    },
    null,
    2,
  ),
);
