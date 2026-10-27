import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import { commitmentBytes, commitmentToHex } from "@trionlabs/stellar-8183";
import { LiveCommerce, verifyOnChain } from "../src/live.js";
import { validateProfile, type Action, type Profile } from "../src/model.js";
import { encodeReceipt, makeReceipt } from "../src/receipt.js";
import { verifyBalanceAccounting, type Balances } from "../src/accounting.js";
import { assertNoSecretEnvironment } from "../src/mainnet-authorization.js";
import {
  MAINNET_ALIASES,
  mainnetAddresses,
  secureStoreWallet,
} from "./mainnet-cli.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const base = resolve(root, "artifacts/mainnet-canary");
const out = resolve(base, "canary");
const acknowledgement = "--execute-valueless-mainnet-canary";

if (process.argv[2] !== acknowledgement)
  throw new Error(
    `Refusing Mainnet writes. Re-run with ${acknowledgement} after reviewing the deployment and confirming these transactions spend real XLM only for fees.`,
  );
assertNoSecretEnvironment(process.env);
await execute(
  "pnpm",
  ["--filter", "@trionlabs/8183-console", "preflight:mainnet", "check"],
  { cwd: root, timeout: 900_000, maxBuffer: 10_000_000 },
);

const profile = validateProfile(
  JSON.parse(await readFile(resolve(base, "profile.json"), "utf8")) as Profile,
);
if (
  profile.id !== "mainnet-canary" ||
  profile.networkPassphrase !== Networks.PUBLIC ||
  profile.symbol !== "DEMO8183" ||
  !profile.canaryAcknowledged
)
  throw new Error(
    "The deployed profile is not the acknowledged Mainnet canary.",
  );
const deployment = JSON.parse(
  await readFile(resolve(base, "deployment.json"), "utf8"),
) as {
  hook: string;
  accounts: Record<keyof typeof MAINNET_ALIASES, string>;
  assetPolicy: {
    redeemable: boolean;
    marketed: boolean;
    distributedOutsideCanaryAccounts: boolean;
    claimOfMonetaryValue: boolean;
  };
};
if (
  deployment.assetPolicy.redeemable ||
  deployment.assetPolicy.marketed ||
  deployment.assetPolicy.distributedOutsideCanaryAccounts ||
  deployment.assetPolicy.claimOfMonetaryValue
)
  throw new Error(
    "The deployment does not preserve the valueless asset policy.",
  );

const addresses = await mainnetAddresses(root);
if (JSON.stringify(addresses) !== JSON.stringify(deployment.accounts))
  throw new Error(
    "Secure-store role addresses differ from the deployment record.",
  );
const clients = Object.fromEntries(
  (Object.keys(MAINNET_ALIASES) as (keyof typeof MAINNET_ALIASES)[]).map(
    (role) => [
      role,
      new LiveCommerce(
        profile,
        secureStoreWallet(root, MAINNET_ALIASES[role], addresses[role]),
      ),
    ],
  ),
) as Record<keyof typeof MAINNET_ALIASES, LiveCommerce>;
const client = clients.client;
const provider = clients.provider;
const evaluator = clients.evaluator;
await client.tokenInfo();
await mkdir(out, { recursive: true });

const balances = async (): Promise<Balances> => {
  const [clientBalance, providerBalance, evaluatorBalance, escrowBalance] =
    await Promise.all([
      client.tokenBalance(addresses.client),
      client.tokenBalance(addresses.provider),
      client.tokenBalance(addresses.evaluator),
      client.tokenBalance(profile.kernel),
    ]);
  return {
    client: clientBalance.toString(),
    provider: providerBalance.toString(),
    evaluator: evaluatorBalance.toString(),
    escrow: escrowBalance.toString(),
  };
};

const scenarios: unknown[] = [];
for (const path of ["complete", "reject", "claim_refund"] as const) {
  const started = Date.now();
  const initial = await balances();
  const expiryOffset = path === "claim_refund" ? 90 : 900;
  let record = await client.create({
    description: `Mainnet valueless canary: ${path}`,
    provider: addresses.provider,
    evaluator: addresses.evaluator,
    hook: deployment.hook,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + expiryOffset),
  });
  const id = record.job.id;
  const transactions = [record.outcome!];
  const act = async (who: LiveCommerce, action: Action, input = {}) => {
    record = await who.act(id, action, input);
    transactions.push(record.outcome!);
    console.log(`job ${id} ${action}: ${record.outcome!.hash}`);
  };
  await act(client, "set_budget", { budget: 10_000_000n });
  await act(client, "fund");
  const fundingTransaction = record.outcome!.hash;
  const funded = await balances();
  if (path === "complete") {
    await act(provider, "submit", {
      commitment: commitmentToHex(
        commitmentBytes("Mainnet valueless canary output"),
      ),
    });
    await act(evaluator, "complete");
  } else if (path === "reject") {
    await act(evaluator, "reject");
  } else {
    while (Math.floor(Date.now() / 1000) <= Number(record.job.expires_at) + 15)
      await new Promise((done) => setTimeout(done, 1_000));
    await act(provider, "claim_refund");
  }
  const receipt = await makeReceipt(profile, record.job, record.outcome!);
  const balanceAccounting = {
    jobId: id.toString(),
    fundingTransaction,
    initial,
    funded,
    terminal: await balances(),
  };
  verifyBalanceAccounting(
    balanceAccounting,
    record.job.budget,
    path === "complete",
  );
  const verification = await verifyOnChain(receipt, profile, client);
  await writeFile(resolve(out, `job-${id}.json`), encodeReceipt(receipt), {
    flag: "wx",
    mode: 0o600,
  });
  scenarios.push({
    jobId: id.toString(),
    path,
    transactions,
    balanceAccounting,
    verification,
    durationSeconds: Math.round((Date.now() - started) / 1_000),
  });
  await writeFile(
    resolve(out, "author-run-report.json"),
    `${JSON.stringify(
      {
        schema: "stellar-8183/author-run/v1",
        generatedAt: new Date().toISOString(),
        evidenceType: "author-run",
        independentParticipant: false,
        profile,
        scenarios,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
console.log(
  "Three Mainnet canary jobs verified: completion, funded evaluator rejection, and permissionless expired refund. This is author-run compatibility evidence, not customer-pilot evidence.",
);
