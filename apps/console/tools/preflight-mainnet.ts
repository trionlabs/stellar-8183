import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Horizon } from "@stellar/stellar-sdk";
import { digest } from "../src/receipt.js";
import {
  assertNoSecretEnvironment,
  parseMainnetAuthorization,
} from "../src/mainnet-authorization.js";
import { assertBuildSource } from "./source.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const configDir = resolve(root, ".stellar/mainnet-canary");
const privateDir = resolve(root, "deployments/private");
const defaultAuthorization = resolve(privateDir, "mainnet-authorization.json");
const aliases = [
  "canary-admin",
  "canary-client",
  "canary-provider",
  "canary-evaluator",
] as const;

const run = async (program: string, args: string[], timeout = 180_000) =>
  (
    await execute(program, args, {
      cwd: root,
      timeout,
      maxBuffer: 5_000_000,
    })
  ).stdout.trim();

const cli = (args: string[]) =>
  run("stellar", ["--config-dir", configDir, ...args]);

async function sourceAndBuild(): Promise<{
  sourceCommit: string;
  kernelWasmSha256: string;
  hookWasmSha256: string;
}> {
  const status = await run("git", ["status", "--porcelain"]);
  if (status)
    throw new Error(
      "Mainnet preflight requires a clean, committed worktree so review evidence identifies exact code.",
    );
  const sourceCommit = await run("git", ["rev-parse", "HEAD"]);
  await assertBuildSource(root, sourceCommit);
  for (const script of [
    "./scripts/verify-release.sh",
    "./scripts/release-build.sh",
  ])
    await execute(script, [], {
      cwd: root,
      timeout: 600_000,
      maxBuffer: 5_000_000,
      env: { ...process.env, SOURCE_REPO: "github:trionlabs/stellar-8183" },
    });
  await assertBuildSource(root, sourceCommit);
  return {
    sourceCommit,
    kernelWasmSha256: await digest(
      await readFile(
        resolve(root, "artifacts/release/stellar_8183_commerce.wasm"),
      ),
    ),
    hookWasmSha256: await digest(
      await readFile(
        resolve(root, "artifacts/release/stellar_8183_sla_hook.wasm"),
      ),
    ),
  };
}

async function prepare(path: string): Promise<void> {
  assertNoSecretEnvironment(process.env);
  const build = await sourceAndBuild();
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schema: "stellar-8183/mainnet-authorization/v1",
        ...build,
        chapterLeadApproval: {
          approver: "",
          reference: "",
          approvedAt: "",
          valuelessCanaryAccepted: true,
        },
        independentAudit: {
          reviewer: "",
          reference: "",
          completedAt: "",
          independentFromBuilder: true,
          unresolvedCritical: 0,
          unresolvedHigh: 0,
        },
        threatModelReview: {
          approver: "",
          reference: "",
          approvedAt: "",
          approved: true,
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Prepared ${path}. Fill it only with real review references; blank fields deliberately fail preflight.`,
  );
}

async function check(path: string): Promise<void> {
  assertNoSecretEnvironment(process.env);
  const authorization = parseMainnetAuthorization(await readFile(path, "utf8"));
  const build = await sourceAndBuild();
  if (
    authorization.sourceCommit !== build.sourceCommit ||
    authorization.kernelWasmSha256 !== build.kernelWasmSha256 ||
    authorization.hookWasmSha256 !== build.hookWasmSha256
  )
    throw new Error(
      "Reviewed source or Wasm does not match the current reproducible build.",
    );
  await cli(["network", "health", "--network", "mainnet"]);
  const accounts: Record<string, { address: string; nativeXlm: string }> = {};
  const addresses = new Set<string>();
  const horizon = new Horizon.Server("https://horizon.stellar.org");
  for (const alias of aliases) {
    const address = await cli(["keys", "address", alias]);
    if (addresses.has(address))
      throw new Error("Every Mainnet canary role must use a distinct account.");
    addresses.add(address);
    const account = await horizon.loadAccount(address);
    const native = account.balances.find(
      (balance) => balance.asset_type === "native",
    );
    if (!native || Number(native.balance) < 1)
      throw new Error(`${alias} needs at least 1 XLM for reserves and fees.`);
    accounts[alias] = { address, nativeXlm: native.balance };
  }
  console.log(
    JSON.stringify(
      {
        status: "READY_FOR_HUMAN_DEPLOYMENT_REVIEW",
        network: "mainnet",
        ...build,
        authorization: {
          chapterLead: authorization.chapterLeadApproval.reference,
          independentAudit: authorization.independentAudit.reference,
          threatModel: authorization.threatModelReview.reference,
        },
        accounts,
        nextStep:
          "Review public accounts and balances, then use the separately reviewed interactive deployment procedure. Preflight does not submit transactions.",
      },
      null,
      2,
    ),
  );
}

const [mode, suppliedPath] = process.argv.slice(2);
const path = suppliedPath ? resolve(suppliedPath) : defaultAuthorization;
if (mode === "prepare") await prepare(path);
else if (mode === "check") await check(path);
else
  throw new Error(
    "Usage: pnpm preflight:mainnet prepare [authorization.json] | check [authorization.json]",
  );
