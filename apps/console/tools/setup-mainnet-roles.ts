import { Horizon } from "@stellar/stellar-sdk";
import { resolve } from "node:path";
import {
  MAINNET_ALIASES,
  ensureMainnetNetwork,
  mainnetAddresses,
  stellarCli,
} from "./mainnet-cli.js";
import { assertNoSecretEnvironment } from "../src/mainnet-authorization.js";

const root = resolve(import.meta.dirname, "../../..");
const acknowledgement = "--fund-mainnet-roles";
if (process.argv[2] !== acknowledgement)
  throw new Error(
    `Usage: pnpm --filter @trionlabs/8183-console setup:mainnet ${acknowledgement}`,
  );
assertNoSecretEnvironment(process.env);

const horizon = new Horizon.Server("https://horizon.stellar.org");
await ensureMainnetNetwork(root);
const addresses = await mainnetAddresses(root);
const fundingAlias = "canary-admin";
const fundingAddress = await stellarCli(root, [
  "keys",
  "address",
  fundingAlias,
]);
if (Object.values(addresses).includes(fundingAddress))
  throw new Error(
    "The high-value funding account must be separate from every canary role.",
  );
const load = async (address: string) => {
  try {
    return await horizon.loadAccount(address);
  } catch (cause) {
    const response = (cause as { response?: { status?: number } }).response;
    if (response?.status === 404) return undefined;
    throw cause;
  }
};
const nativeStroops = (balance: string): bigint => {
  const [whole, fraction = ""] = balance.split(".");
  if (!whole || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction))
    throw new Error("Horizon returned an invalid XLM balance.");
  return (
    BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7))
  );
};
const balance = async (address: string): Promise<bigint | undefined> => {
  const account = await load(address);
  if (!account) return undefined;
  const native = account.balances.find((item) => item.asset_type === "native");
  if (!native) throw new Error("Mainnet account has no native balance entry.");
  return nativeStroops(native.balance);
};
const waitFor = async (address: string, minimum: bigint): Promise<void> => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const amount = await balance(address);
    if (amount !== undefined && amount >= minimum) return;
    await new Promise((done) => setTimeout(done, 5_000));
  }
  throw new Error("Horizon did not confirm the funded role account.");
};

const targets = {
  admin: 100_000_000n,
  client: 20_000_000n,
  provider: 20_000_000n,
  evaluator: 20_000_000n,
} as const;
const roles = Object.keys(targets) as (keyof typeof targets)[];
const current = new Map<(typeof roles)[number], bigint | undefined>();
let required = 10_000_000n;
for (const role of roles) {
  const amount = await balance(addresses[role]);
  current.set(role, amount);
  if (amount === undefined) required += targets[role];
  else if (amount < targets[role]) required += targets[role] - amount;
}
const fundingBalance = await balance(fundingAddress);
if (fundingBalance === undefined)
  throw new Error("The funding-only account is not funded on Stellar Mainnet.");
if (fundingBalance < required)
  throw new Error(
    `The funding-only account needs at least ${Number(required) / 10_000_000} XLM to fund isolated canary accounts and a 1 XLM fee buffer.`,
  );

for (const role of roles) {
  const amount = current.get(role);
  const target = targets[role];
  if (amount === undefined)
    await stellarCli(root, [
      "tx",
      "new",
      "create-account",
      "--source-account",
      fundingAlias,
      "--destination",
      addresses[role],
      "--starting-balance",
      target.toString(),
      "--network",
      "mainnet",
    ]);
  else if (amount < target)
    await stellarCli(root, [
      "tx",
      "new",
      "payment",
      "--source-account",
      fundingAlias,
      "--destination",
      addresses[role],
      "--asset",
      "native",
      "--amount",
      (target - amount).toString(),
      "--network",
      "mainnet",
    ]);
  await waitFor(addresses[role], target);
}

console.log(
  JSON.stringify(
    {
      status: "MAINNET_CANARY_ROLES_FUNDED",
      fundingAccount: fundingAddress,
      accounts: addresses,
      balancesXlm: { admin: 10, client: 2, provider: 2, evaluator: 2 },
      next: "Run the Mainnet preflight, then prepare the deterministic deployment plan.",
    },
    null,
    2,
  ),
);
