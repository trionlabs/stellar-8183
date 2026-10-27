import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { digest } from "../src/receipt.js";
import { validateProfile, type Profile } from "../src/model.js";
import { assertBuildSource } from "./source.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const configDir = resolve(root, ".stellar/month-two");
const out = resolve(root, "artifacts/month-two");
const sourceCommit = (
  await execute("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
const assertSource = () => assertBuildSource(root, sourceCommit);
await assertSource();
try {
  await readFile(resolve(out, "profile.json"));
  throw new Error(
    "A deployment profile already exists. Reuse it; this command refuses a duplicate deployment.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
for (const script of [
  "./scripts/verify-release.sh",
  "./scripts/release-build.sh",
])
  await execute(script, [], {
    cwd: root,
    timeout: 600000,
    maxBuffer: 5_000_000,
    env: { ...process.env, SOURCE_REPO: "github:trionlabs/stellar-8183" },
  });
await assertSource();
await mkdir(out, { recursive: true });
await mkdir(configDir, { recursive: true, mode: 0o700 });
const cli = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execute(
      "stellar",
      ["--config-dir", configDir, ...args],
      { cwd: root, timeout: 180000, maxBuffer: 2_000_000 },
    );
    return stdout.trim();
  } catch {
    throw new Error(
      `Stellar CLI failed at ${args.slice(0, 3).join(" ")}. Inspect network availability; secret output is suppressed.`,
    );
  }
};
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const keys: Record<string, Keypair> = {};
for (const role of ["admin", "client", "provider", "evaluator"]) {
  const alias = `m2-${role}`;
  const publicPath = resolve(configDir, `${alias}.public`);
  try {
    await readFile(publicPath);
  } catch {
    await cli(["keys", "generate", alias, "--network", "testnet", "--fund"]);
    const pub = await cli(["keys", "address", alias]);
    await writeFile(publicPath, pub, { flag: "wx", mode: 0o600 });
  }
  keys[role] = Keypair.fromSecret(await cli(["keys", "show", alias]));
}
const admin = keys.admin!;
const asset = new Asset("DEMO8183", admin.publicKey());
const classic = async (
  key: Keypair,
  operations: ReturnType<typeof Operation.changeTrust>[],
): Promise<string> => {
  const account = await horizon.loadAccount(key.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  });
  operations.forEach((op) => tx.addOperation(op));
  const built = tx.setTimeout(120).build();
  built.sign(key);
  const result = await horizon.submitTransaction(built);
  return result.hash;
};
for (const role of ["client", "provider", "evaluator"]) {
  const key = keys[role]!;
  const account = await horizon.loadAccount(key.publicKey());
  if (
    !account.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === asset.code &&
        b.asset_issuer === asset.issuer,
    )
  )
    await classic(key, [Operation.changeTrust({ asset })]);
}
await classic(admin, [
  Operation.payment({
    destination: keys.client!.publicKey(),
    asset,
    amount: "100",
  }),
]);
const assetId = asset.contractId(Networks.TESTNET);
try {
  await cli([
    "contract",
    "asset",
    "deploy",
    "--asset",
    `DEMO8183:${admin.publicKey()}`,
    "--source-account",
    "m2-admin",
    "--network",
    "testnet",
  ]);
} catch {
  // SAC deploy is idempotent only at the ledger level; verify existence by
  // reading metadata rather than treating a failed command as proof.
  await cli([
    "contract",
    "invoke",
    "--id",
    assetId,
    "--source-account",
    "m2-admin",
    "--network",
    "testnet",
    "--send",
    "no",
    "--",
    "symbol",
  ]);
}
const base = ["--source-account", "m2-admin", "--network", "testnet"];
const kernel = await cli([
  "contract",
  "deploy",
  "--wasm",
  "artifacts/release/stellar_8183_commerce.wasm",
  ...base,
  "--",
  "--admin",
  admin.publicKey(),
  "--token",
  assetId,
]);
const hook = await cli([
  "contract",
  "deploy",
  "--wasm",
  "artifacts/release/stellar_8183_sla_hook.wasm",
  ...base,
  "--",
  "--core",
  kernel,
  "--review-secs",
  "10",
]);
await cli([
  "contract",
  "invoke",
  "--id",
  kernel,
  ...base,
  "--",
  "set_hook",
  "--hook",
  hook,
  "--allowed",
  "true",
]);
const hashes: Record<string, string> = {};
for (const [name, id] of [
  ["commerce", kernel],
  ["sla_hook", hook],
] as const) {
  const file = resolve(out, `fetched-${name}.wasm`);
  await cli([
    "contract",
    "fetch",
    "--id",
    id,
    "--network",
    "testnet",
    "--out-file",
    file,
  ]);
  const local = await readFile(
    resolve(root, `artifacts/release/stellar_8183_${name}.wasm`),
  );
  const fetched = await readFile(file);
  if ((await digest(local)) !== (await digest(fetched)))
    throw new Error(`${name} deployed Wasm does not match the build.`);
  hashes[name] = await digest(local);
}
await assertSource();
const profile: Profile = validateProfile({
  id: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  kernel,
  token: assetId,
  symbol: "DEMO8183",
  decimals: 7,
  maxFee: "10000000",
  canaryAcknowledged: false,
});
await writeFile(
  resolve(out, "profile.json"),
  JSON.stringify(profile, null, 2),
  { flag: "wx" },
);
await writeFile(
  resolve(out, "deployment.json"),
  JSON.stringify(
    {
      schema: "stellar-8183/canary-deployment/v1",
      network: "testnet",
      evidenceType: "author-run",
      profile,
      hook,
      sourceCommit,
      wasmSha256: hashes,
      accounts: Object.fromEntries(
        Object.entries(keys).map(([r, key]) => [r, key.publicKey()]),
      ),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      profile: resolve(out, "profile.json"),
      kernel,
      hook,
      token: assetId,
      status:
        "Testnet deployment verified. Author-controlled identities; not independent pilot evidence.",
    },
    null,
    2,
  ),
);
