import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { commitmentBytes, commitmentToHex } from "@trionlabs/stellar-8183";
import { LiveCommerce, verifyOnChain, type Wallet } from "../src/live.js";
import { validateProfile, type Action, type Profile } from "../src/model.js";
import { encodeReceipt, makeReceipt } from "../src/receipt.js";
import { verifyBalanceAccounting, type Balances } from "../src/accounting.js";

const root = resolve(import.meta.dirname, "../../..");
const profilePath =
  process.argv[2] ?? resolve(root, "artifacts/month-two/profile.json");
const profile = validateProfile(
  JSON.parse(await readFile(profilePath, "utf8")) as Profile,
);
const deployment = JSON.parse(
  await readFile(resolve(root, "artifacts/month-two/deployment.json"), "utf8"),
) as { hook: string };
if (profile.id !== "testnet" || profile.networkPassphrase !== Networks.TESTNET)
  throw new Error("The author-run pilot command is testnet-only.");
const execute = promisify(execFile);
const clients: Record<string, LiveCommerce> = {};
for (const role of ["client", "provider", "evaluator"]) {
  const { stdout } = await execute("stellar", [
    "keys",
    "show",
    `m2-${role}`,
    "--config-dir",
    resolve(root, ".stellar/month-two"),
  ]);
  const key = Keypair.fromSecret(stdout.trim());
  const wallet: Wallet = {
    address: key.publicKey(),
    sign: async (xdr, p) => {
      const tx = TransactionBuilder.fromXDR(xdr, p.networkPassphrase);
      tx.sign(key);
      return tx.toXDR();
    },
  };
  clients[role] = new LiveCommerce(profile, wallet);
}
const client = clients.client!,
  provider = clients.provider!,
  evaluator = clients.evaluator!;
await client.tokenInfo();
const out = resolve(root, "artifacts/month-two/pilot");
await mkdir(out, { recursive: true });
const report: unknown[] = [];
const balances = async (): Promise<Balances> => {
  const [c, p, e, k] = await Promise.all([
    client.tokenBalance(client.wallet.address),
    client.tokenBalance(provider.wallet.address),
    client.tokenBalance(evaluator.wallet.address),
    client.tokenBalance(profile.kernel),
  ]);
  return {
    client: c.toString(),
    provider: p.toString(),
    evaluator: e.toString(),
    escrow: k.toString(),
  };
};
for (const path of [
  "complete",
  "reject",
  "claim_refund",
  "complete",
  "reject",
  "claim_refund",
] as const) {
  const started = Date.now();
  const initial = await balances();
  let record = await client.create({
    description: `Author-run ${path} verification; not customer evidence`,
    provider: provider.wallet.address,
    evaluator: evaluator.wallet.address,
    hook: deployment.hook,
    expiresAt: BigInt(
      Math.floor(Date.now() / 1000) + (path === "claim_refund" ? 90 : 900),
    ),
  });
  const id = record.job.id;
  const transactions = [record.outcome!];
  const act = async (who: LiveCommerce, action: Action, input = {}) => {
    record = await who.act(id, action, input);
    transactions.push(record.outcome!);
    console.log(`job ${id} ${action}: ${record.outcome!.hash}`);
  };
  await act(client, "set_budget", { budget: 1_0000000n });
  await act(client, "fund");
  const fundingTransaction = record.outcome!.hash;
  const funded = await balances();
  if (path === "complete") {
    await act(provider, "submit", {
      commitment: commitmentToHex(
        commitmentBytes("Research artifact: author-run test"),
      ),
    });
    await act(evaluator, "complete");
  } else if (path === "reject") await act(evaluator, "reject");
  else {
    while (BigInt(Math.floor(Date.now() / 1000)) <= record.job.expires_at + 5n)
      await new Promise((r) => setTimeout(r, 1000));
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
  });
  report.push({
    jobId: id.toString(),
    path,
    transactions,
    balanceAccounting,
    verification,
    durationSeconds: Math.round((Date.now() - started) / 1000),
  });
  await writeFile(
    resolve(out, "author-run-report.json"),
    JSON.stringify(
      {
        schema: "stellar-8183/author-run/v1",
        generatedAt: new Date().toISOString(),
        evidenceType: "author-run",
        independentParticipant: false,
        profile,
        scenarios: report,
      },
      null,
      2,
    ),
  );
}
console.log(
  "Six real testnet jobs verified. These are author-run integration tests, not an independent customer pilot.",
);
