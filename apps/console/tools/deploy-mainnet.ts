import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  Address,
  Asset,
  Horizon,
  Networks,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { digest } from "../src/receipt.js";
import { validateProfile, type Profile } from "../src/model.js";
import { assertNoSecretEnvironment } from "../src/mainnet-authorization.js";
import { assertBuildSource } from "./source.js";
import {
  MAINNET_ALIASES,
  mainnetAddresses,
  stellarCli,
} from "./mainnet-cli.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const out = resolve(root, "artifacts/mainnet-canary");
const acknowledgement = "--execute-valueless-mainnet-canary";
const planOnly = "--prepare-plan";

if (![acknowledgement, planOnly].includes(process.argv[2] ?? ""))
  throw new Error(
    `Usage: pnpm --filter @trionlabs/8183-console deploy:mainnet ${planOnly} | ${acknowledgement}`,
  );
assertNoSecretEnvironment(process.env);

await execute(
  "pnpm",
  ["--filter", "@trionlabs/8183-console", "preflight:mainnet", "check"],
  { cwd: root, timeout: 900_000, maxBuffer: 10_000_000 },
);

const status = (
  await execute("git", ["status", "--porcelain"], { cwd: root })
).stdout.trim();
if (status)
  throw new Error("Mainnet deployment requires a clean, committed worktree.");
const sourceCommit = (
  await execute("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
await assertBuildSource(root, sourceCommit);
const addresses = await mainnetAddresses(root);
const admin = addresses.admin;
const classicAsset = `DEMO8183:${admin}`;
const asset = new Asset("DEMO8183", admin);
const token = asset.contractId(Networks.PUBLIC);
const release = {
  commerce: resolve(root, "artifacts/release/stellar_8183_commerce.wasm"),
  sla_hook: resolve(root, "artifacts/release/stellar_8183_sla_hook.wasm"),
};
const hashes = {
  commerce: await digest(await readFile(release.commerce)),
  sla_hook: await digest(await readFile(release.sla_hook)),
};
const salt = (component: string): string =>
  createHash("sha256")
    .update(`stellar-8183/mainnet-canary/v1/${component}/${sourceCommit}`)
    .digest("hex");
const kernelSalt = salt("kernel");
const hookSalt = salt("sla-hook");
const id = (value: string) =>
  stellarCli(root, [
    "contract",
    "id",
    "wasm",
    "--salt",
    value,
    "--source-account",
    MAINNET_ALIASES.admin,
    "--network",
    "mainnet",
  ]);
const kernel = await id(kernelSalt);
const hook = await id(hookSalt);
const profile: Profile = validateProfile({
  id: "mainnet-canary",
  rpcUrl: "https://mainnet.sorobanrpc.com",
  networkPassphrase: Networks.PUBLIC,
  kernel,
  token,
  symbol: "DEMO8183",
  decimals: 7,
  maxFee: "10000000",
  canaryAcknowledged: true,
});

await mkdir(out, { recursive: true });
const deploymentPlan = `${JSON.stringify(
  {
    schema: "stellar-8183/mainnet-deployment-plan/v1",
    network: "mainnet",
    asset: classicAsset,
    profile,
    hook,
    reviewSeconds: 10,
    sourceCommit,
    wasmSha256: hashes,
    salts: { kernel: kernelSalt, hook: hookSalt },
    accounts: addresses,
    warning:
      "Real Mainnet XLM pays reserves and fees. DEMO8183 is non-redeemable, valueless, and confined to these canary accounts.",
  },
  null,
  2,
)}\n`;
const planPath = resolve(out, "deployment-plan.json");
try {
  await writeFile(planPath, deploymentPlan, { flag: "wx", mode: 0o600 });
} catch (cause) {
  if (
    (cause as NodeJS.ErrnoException).code !== "EEXIST" ||
    (await readFile(planPath, "utf8")) !== deploymentPlan
  )
    throw new Error(
      "Existing Mainnet deployment plan differs from the reviewed deterministic plan.",
    );
}

if (process.argv[2] === planOnly) {
  console.log(
    JSON.stringify(
      {
        status: "MAINNET_CANARY_PLAN_READY",
        plan: planPath,
        next: `Review the plan, then re-run with ${acknowledgement}. That command will spend real XLM on fees and reserves.`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const horizon = new Horizon.Server("https://horizon.stellar.org");
const rpcServer = new rpc.Server(profile.rpcUrl);
const contractExists = async (contractId: string): Promise<boolean> => {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  return (await rpcServer.getLedgerEntries(key)).entries.length === 1;
};
for (const [role, address] of Object.entries(addresses)) {
  const account = await horizon.loadAccount(address);
  if (
    role === "admin" &&
    (account.flags.auth_required ||
      account.flags.auth_revocable ||
      account.flags.auth_clawback_enabled)
  )
    throw new Error(
      "Canary issuer must not require, revoke, freeze, or claw back DEMO8183 trustlines.",
    );
  const native = account.balances.find(
    (balance) => balance.asset_type === "native",
  );
  const minimum = role === "admin" ? 5 : 2;
  if (!native || Number(native.balance) < minimum)
    throw new Error(
      `${role} needs at least ${minimum} XLM before Mainnet writes.`,
    );
}

for (const role of ["client", "provider", "evaluator"] as const) {
  const account = await horizon.loadAccount(addresses[role]);
  const hasTrustline = account.balances.some(
    (balance) =>
      balance.asset_type !== "native" &&
      "asset_code" in balance &&
      balance.asset_code === "DEMO8183" &&
      balance.asset_issuer === admin,
  );
  if (!hasTrustline)
    await stellarCli(root, [
      "tx",
      "new",
      "change-trust",
      "--source-account",
      MAINNET_ALIASES[role],
      "--line",
      classicAsset,
      "--network",
      "mainnet",
    ]);
}

const waitForTrustline = async (role: "client" | "provider" | "evaluator") => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const account = await horizon.loadAccount(addresses[role]);
    const line = account.balances.find(
      (balance) =>
        balance.asset_type !== "native" &&
        "asset_code" in balance &&
        balance.asset_code === "DEMO8183" &&
        balance.asset_issuer === admin,
    );
    if (line) return line;
    await new Promise((done) => setTimeout(done, 5_000));
  }
  throw new Error(`${role} DEMO8183 trustline was not visible in Horizon.`);
};

const balanceStroops = (balance: string): bigint => {
  const [whole, fraction = ""] = balance.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction))
    throw new Error("Horizon returned an invalid DEMO8183 balance.");
  return (
    BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7))
  );
};
let holders = await horizon.accounts().forAsset(asset).limit(200).call();
const canaryAccounts = new Set(Object.values(addresses));
if (
  holders.records.length > canaryAccounts.size ||
  holders.records.some((record) => !canaryAccounts.has(record.account_id))
)
  throw new Error("DEMO8183 already has a holder outside the canary accounts.");
let issuedStroops = 0n;
for (const role of ["client", "provider", "evaluator"] as const) {
  const line = await waitForTrustline(role);
  issuedStroops += balanceStroops(line.balance);
}
const targetStroops = 10n * 10_000_000n;
if (issuedStroops > targetStroops)
  throw new Error("DEMO8183 supply exceeds the fixed 10-token canary cap.");
if (issuedStroops < targetStroops)
  await stellarCli(root, [
    "tx",
    "new",
    "payment",
    "--source-account",
    MAINNET_ALIASES.admin,
    "--destination",
    addresses.client,
    "--asset",
    classicAsset,
    "--amount",
    (targetStroops - issuedStroops).toString(),
    "--network",
    "mainnet",
  ]);

let visibleSupply = 0n;
for (let attempt = 0; attempt < 12; attempt += 1) {
  visibleSupply = 0n;
  for (const role of ["client", "provider", "evaluator"] as const)
    visibleSupply += balanceStroops((await waitForTrustline(role)).balance);
  if (visibleSupply === targetStroops) break;
  await new Promise((done) => setTimeout(done, 5_000));
}
if (visibleSupply !== targetStroops)
  throw new Error("Horizon did not confirm the fixed 10-token canary supply.");

holders = await horizon.accounts().forAsset(asset).limit(200).call();
if (
  holders.records.length > canaryAccounts.size ||
  holders.records.some((record) => !canaryAccounts.has(record.account_id))
)
  throw new Error("DEMO8183 was distributed outside the canary accounts.");

const view = async (
  contractId: string,
  method: string,
  args: string[] = [],
): Promise<unknown> => {
  const output = await stellarCli(root, [
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source-account",
    admin,
    "--network",
    "mainnet",
    "--send",
    "no",
    "--",
    method,
    ...args,
  ]);
  return JSON.parse(output) as unknown;
};

if (!(await contractExists(token))) {
  const deployed = await stellarCli(root, [
    "contract",
    "asset",
    "deploy",
    "--asset",
    classicAsset,
    "--source-account",
    MAINNET_ALIASES.admin,
    "--network",
    "mainnet",
  ]);
  if (deployed !== token)
    throw new Error("Asset contract deployment returned an unexpected ID.");
}
const tokenSymbol = await view(token, "symbol");
if (tokenSymbol !== "DEMO8183")
  throw new Error("Asset contract has an unexpected symbol.");

const fetchAndVerify = async (
  contractId: string,
  localPath: string,
  expectedHash: string,
  outputName: string,
): Promise<void> => {
  const temporary = await mkdtemp(resolve(tmpdir(), "stellar-8183-fetch-"));
  const fetchedPath = resolve(temporary, "contract.wasm");
  try {
    await stellarCli(root, [
      "contract",
      "fetch",
      "--id",
      contractId,
      "--network",
      "mainnet",
      "--out-file",
      fetchedPath,
    ]);
    const bytes = await readFile(fetchedPath);
    if ((await digest(bytes)) !== expectedHash)
      throw new Error(
        `${outputName} Mainnet Wasm differs from the release build.`,
      );
    if ((await digest(await readFile(localPath))) !== expectedHash)
      throw new Error(`${outputName} local Wasm changed during deployment.`);
    await writeFile(resolve(out, `fetched-${outputName}.wasm`), bytes);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

if (!(await contractExists(kernel))) {
  const deployed = await stellarCli(root, [
    "contract",
    "deploy",
    "--wasm",
    release.commerce,
    "--optimize=false",
    "--salt",
    kernelSalt,
    "--source-account",
    MAINNET_ALIASES.admin,
    "--network",
    "mainnet",
    "--",
    "--admin",
    admin,
    "--token",
    token,
  ]);
  if (deployed !== kernel)
    throw new Error("Kernel deployment returned an unexpected contract ID.");
}
if (!(await contractExists(hook))) {
  const deployed = await stellarCli(root, [
    "contract",
    "deploy",
    "--wasm",
    release.sla_hook,
    "--optimize=false",
    "--salt",
    hookSalt,
    "--source-account",
    MAINNET_ALIASES.admin,
    "--network",
    "mainnet",
    "--",
    "--core",
    kernel,
    "--review-secs",
    "10",
  ]);
  if (deployed !== hook)
    throw new Error("SLA-hook deployment returned an unexpected contract ID.");
}
await fetchAndVerify(kernel, release.commerce, hashes.commerce, "commerce");
await fetchAndVerify(hook, release.sla_hook, hashes.sla_hook, "sla_hook");

if (
  (await view(kernel, "get_admin")) !== admin ||
  (await view(kernel, "get_token")) !== token ||
  (await view(hook, "get_core")) !== kernel ||
  (await view(hook, "review_secs")) !== 10
)
  throw new Error(
    "Deployed constructor state does not match the reviewed plan.",
  );
if ((await view(kernel, "is_hook", ["--hook", hook])) !== true)
  await stellarCli(root, [
    "contract",
    "invoke",
    "--id",
    kernel,
    "--source-account",
    MAINNET_ALIASES.admin,
    "--network",
    "mainnet",
    "--",
    "set_hook",
    "--hook",
    hook,
    "--allowed",
    "true",
  ]);
if ((await view(kernel, "is_hook", ["--hook", hook])) !== true)
  throw new Error("SLA hook admission could not be verified.");

await assertBuildSource(root, sourceCommit);
await writeFile(
  resolve(out, "profile.json"),
  `${JSON.stringify(profile, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
await writeFile(
  resolve(out, "deployment.json"),
  `${JSON.stringify(
    {
      schema: "stellar-8183/canary-deployment/v1",
      network: "mainnet",
      evidenceType: "author-run",
      profile,
      hook,
      sourceCommit,
      wasmSha256: hashes,
      accounts: addresses,
      reviewSeconds: 10,
      assetPolicy: {
        redeemable: false,
        marketed: false,
        distributedOutsideCanaryAccounts: false,
        claimOfMonetaryValue: false,
      },
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      status: "MAINNET_CANARY_DEPLOYED_AND_VERIFIED",
      kernel,
      hook,
      token,
      profile: resolve(out, "profile.json"),
      next: "Run pnpm --filter @trionlabs/8183-console canary:mainnet --execute-valueless-mainnet-canary",
    },
    null,
    2,
  ),
);
