import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  NotFoundError,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { commitmentBytes, commitmentToHex } from "@trionlabs/stellar-8183";
import { verifyBalanceAccounting, type Balances } from "../src/accounting.js";
import { LiveCommerce, verifyOnChain, type Wallet } from "../src/live.js";
import { validateProfile, type Action, type Profile } from "../src/model.js";
import {
  encodeReceipt,
  makeReceipt,
  type ReceiptFile,
} from "../src/receipt.js";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const configDir = resolve(root, ".stellar/month-two");
const artifactDir = resolve(root, "artifacts/month-two/independent-pilot");
const secretPath = resolve(configDir, "pilot-participant-01.secret");
const reportPath = resolve(artifactDir, "independent-pilot-evidence.json");
const partialPath = resolve(
  artifactDir,
  "independent-pilot-evidence.partial.json",
);
const sourceCommit = (
  await execute("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
const sourceInputs = [
  "apps/console",
  "packages/sdk",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
];
await execute("git", ["diff", "--exit-code", "HEAD", "--", ...sourceInputs], {
  cwd: root,
});
const untrackedInputs = (
  await execute(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...sourceInputs],
    { cwd: root },
  )
).stdout.trim();
if (untrackedInputs)
  throw new Error(
    "Commit the facilitated pilot runner and application inputs before producing evidence.",
  );
const profile = validateProfile(
  JSON.parse(
    await readFile(resolve(root, "artifacts/month-two/profile.json"), "utf8"),
  ) as Profile,
);
const deployment = JSON.parse(
  await readFile(resolve(root, "artifacts/month-two/deployment.json"), "utf8"),
) as { hook: string };

if (profile.id !== "testnet" || profile.networkPassphrase !== Networks.TESTNET)
  throw new Error("The facilitated pilot runner is Testnet-only.");
try {
  await readFile(reportPath);
  throw new Error(
    "Final pilot evidence already exists. This command refuses to overwrite it.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

await mkdir(configDir, { recursive: true, mode: 0o700 });
await mkdir(artifactDir, { recursive: true });

const cliSecret = async (alias: string): Promise<Keypair> => {
  const { stdout } = await execute("stellar", [
    "keys",
    "show",
    alias,
    "--config-dir",
    configDir,
  ]);
  return Keypair.fromSecret(stdout.trim());
};
const admin = await cliSecret("m2-admin");
const providerKey = await cliSecret("m2-provider");
const evaluatorKey = await cliSecret("m2-evaluator");

let participantKey: Keypair;
try {
  participantKey = Keypair.fromSecret(
    (await readFile(secretPath, "utf8")).trim(),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  participantKey = Keypair.random();
  await writeFile(secretPath, `${participantKey.secret()}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
await chmod(secretPath, 0o600);

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
let friendbotTransaction: string | null = null;
try {
  await horizon.loadAccount(participantKey.publicKey());
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(participantKey.publicKey())}`,
  );
  if (!response.ok)
    throw new Error(`Friendbot funding failed with HTTP ${response.status}.`);
  const funded = (await response.json()) as { hash?: string };
  friendbotTransaction = funded.hash ?? null;
}

const submitClassic = async (
  signer: Keypair,
  operations: xdr.Operation[],
): Promise<string> => {
  const account = await horizon.loadAccount(signer.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  });
  for (const operation of operations) builder.addOperation(operation);
  const transaction = builder.setTimeout(120).build();
  transaction.sign(signer);
  return (await horizon.submitTransaction(transaction)).hash;
};

const asset = new Asset("DEMO8183", admin.publicKey());
if (asset.contractId(Networks.TESTNET) !== profile.token)
  throw new Error("The configured DEMO8183 token does not match the issuer.");
const participantAccount = await horizon.loadAccount(
  participantKey.publicKey(),
);
const hasTrustline = participantAccount.balances.some(
  (balance) =>
    balance.asset_type !== "native" &&
    "asset_code" in balance &&
    balance.asset_code === asset.code &&
    balance.asset_issuer === asset.issuer,
);
const trustlineTransaction = hasTrustline
  ? null
  : await submitClassic(participantKey, [Operation.changeTrust({ asset })]);
const assetFundingTransaction = await submitClassic(admin, [
  Operation.payment({
    destination: participantKey.publicKey(),
    asset,
    amount: "20",
  }),
]);

const commerce = (key: Keypair): LiveCommerce => {
  const wallet: Wallet = {
    address: key.publicKey(),
    sign: async (transactionXdr, selectedProfile) => {
      const transaction = TransactionBuilder.fromXDR(
        transactionXdr,
        selectedProfile.networkPassphrase,
      );
      transaction.sign(key);
      return transaction.toXDR();
    },
  };
  return new LiveCommerce(profile, wallet);
};
const client = commerce(participantKey);
const provider = commerce(providerKey);
const evaluator = commerce(evaluatorKey);
await client.tokenInfo();

const balances = async (): Promise<Balances> => {
  const [clientBalance, providerBalance, evaluatorBalance, escrowBalance] =
    await Promise.all([
      client.tokenBalance(client.wallet.address),
      client.tokenBalance(provider.wallet.address),
      client.tokenBalance(evaluator.wallet.address),
      client.tokenBalance(profile.kernel),
    ]);
  return {
    client: clientBalance.toString(),
    provider: providerBalance.toString(),
    evaluator: evaluatorBalance.toString(),
    escrow: escrowBalance.toString(),
  };
};

interface Scenario {
  jobId: string;
  path: "completion" | "funded-rejection" | "expired-refund";
  ordinal: number;
  transactions: Array<{ hash: string; ledger: number; method: string }>;
  balanceAccounting: {
    jobId: string;
    fundingTransaction: string;
    initial: Balances;
    funded: Balances;
    terminal: Balances;
  };
  receipt: ReceiptFile;
  verification: unknown;
  proxyExecutionDurationSeconds: number;
}

const scenarios: Scenario[] = [];
const plan = [
  ["completion", 1],
  ["funded-rejection", 1],
  ["expired-refund", 1],
  ["completion", 2],
  ["funded-rejection", 2],
  ["expired-refund", 2],
] as const;
const startedAt = new Date().toISOString();

for (const [path, ordinal] of plan) {
  const started = Date.now();
  const initial = await balances();
  let record = await client.create({
    description: `Independent pilot [participant-01 ${path} ${ordinal}]; coordinator-approved proxy`,
    provider: provider.wallet.address,
    evaluator: evaluator.wallet.address,
    hook: deployment.hook,
    expiresAt: BigInt(
      Math.floor(Date.now() / 1000) + (path === "expired-refund" ? 45 : 900),
    ),
  });
  const transactions = [record.outcome!];
  const act = async (
    actor: LiveCommerce,
    action: Action,
    input: Record<string, unknown> = {},
  ) => {
    record = await actor.act(record.job.id, action, input);
    transactions.push(record.outcome!);
    console.log(
      `job ${record.job.id.toString()} ${action}: ${record.outcome!.hash}`,
    );
  };
  await act(client, "set_budget", { budget: 1_0000000n });
  await act(client, "fund");
  const fundingTransaction = record.outcome!.hash;
  const funded = await balances();

  if (path === "completion") {
    await act(provider, "submit", {
      commitment: commitmentToHex(
        commitmentBytes(`Participant-01 proxy deliverable ${ordinal}`),
      ),
    });
    await act(evaluator, "complete");
  } else if (path === "funded-rejection") {
    await act(evaluator, "reject");
  } else {
    while (BigInt(Math.floor(Date.now() / 1000)) <= record.job.expires_at + 5n)
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    await act(client, "claim_refund");
  }

  const receipt = await makeReceipt(profile, record.job, record.outcome!);
  const balanceAccounting = {
    jobId: record.job.id.toString(),
    fundingTransaction,
    initial,
    funded,
    terminal: await balances(),
  };
  verifyBalanceAccounting(
    balanceAccounting,
    record.job.budget,
    path === "completion",
  );
  const verification = await verifyOnChain(receipt, profile, client);
  await writeFile(
    resolve(artifactDir, `job-${record.job.id.toString()}.json`),
    encodeReceipt(receipt),
    { flag: "wx" },
  );
  scenarios.push({
    jobId: record.job.id.toString(),
    path,
    ordinal,
    transactions,
    balanceAccounting,
    receipt,
    verification,
    proxyExecutionDurationSeconds: Math.round((Date.now() - started) / 1000),
  });
  await writeFile(partialPath, `${JSON.stringify({ scenarios }, null, 2)}\n`, {
    mode: 0o600,
  });
}

const evidence = {
  schema: "stellar-8183/independent-pilot/v1",
  status: "proxy-transaction-paths-complete",
  generatedAt: new Date().toISOString(),
  startedAt,
  sourceCommit,
  participantReference: "pilot-participant-01",
  publicParticipantName: null,
  independentParticipant: true,
  unaffiliatedWithTrionLabs: true,
  executionMode: "coordinator-approved-proxy",
  participantPersonallySignedTransactions: false,
  coordinatorException: {
    approved: true,
    approvalDate: "2026-10-27",
    source: "Private coordinator confirmation reported by the project lead",
    publicNameDisclosureRequired: false,
  },
  participantConsent: {
    confirmed: true,
    source: "Private participant confirmation reported by the project lead",
  },
  keyCustody: {
    kind: "disposable-shared-testnet-key",
    generatedByProjectOperator: true,
    network: "testnet",
    containsMonetaryValue: false,
    secretPublished: false,
  },
  limitations: [
    "Proxy execution does not measure participant onboarding time.",
    "Proxy execution does not prove that the participant personally approved each wallet prompt.",
    "Interview findings and a continue/change/stop decision require separate participant input.",
  ],
  participantWallet: participantKey.publicKey(),
  providerWallet: providerKey.publicKey(),
  evaluatorWallet: evaluatorKey.publicKey(),
  profile,
  setupTransactions: {
    friendbot: friendbotTransaction,
    trustline: trustlineTransaction,
    assetFunding: assetFundingTransaction,
  },
  scenarios,
};
await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: "wx",
});

console.log(
  JSON.stringify(
    {
      reportPath,
      participantWallet: participantKey.publicKey(),
      secretHandoffPath: secretPath,
      warning:
        "The secret is Testnet-only and must never be committed or pasted into chat.",
      jobs: scenarios.map(({ jobId, path, receipt }) => ({
        jobId,
        path,
        state: receipt.receipt.state,
        transaction: receipt.receipt.terminalTransaction.hash,
      })),
    },
    null,
    2,
  ),
);
