import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  Address,
  Horizon,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { decodeContractEvent } from "@trionlabs/stellar-8183";
import {
  encodeCanaryEvidence,
  parseCanaryEvidence,
  type CanaryEvidence,
} from "../src/canary.js";
import { LiveCommerce } from "../src/live.js";
import { parseReceipt, digestText } from "../src/receipt.js";
import { validateProfile, type Profile } from "../src/model.js";
import type { BalanceAccounting } from "../src/accounting.js";

const root = resolve(import.meta.dirname, "../../..");
const dir = process.argv[2] ?? resolve(root, "artifacts/month-two");
const deployment = JSON.parse(
  await readFile(resolve(dir, "deployment.json"), "utf8"),
) as {
  profile: Profile;
  hook: string;
  sourceCommit: string;
  wasmSha256: { commerce: string; sla_hook: string };
  accounts: { admin: string; client: string };
};
const profile = validateProfile(deployment.profile);
if (profile.networkPassphrase !== Networks.TESTNET)
  throw new Error("This automated capture is testnet-only.");
const reader = new LiveCommerce(profile, {
  address: deployment.accounts.client,
  sign: async () => {
    throw new Error("Capture cannot sign.");
  },
});
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const transactions = await horizon
  .transactions()
  .forAccount(deployment.accounts.admin)
  .order("desc")
  .limit(100)
  .call();
const deploymentTransactions = { kernel: "", hook: "", admission: "" };
const archive: unknown[] = [];
for (const row of transactions.records) {
  const result = await reader.server.getTransaction(row.hash);
  if (result.status !== "SUCCESS") continue;
  const tx = TransactionBuilder.fromXDR(
    result.envelopeXdr,
    profile.networkPassphrase,
  );
  if (!(tx instanceof Transaction) || tx.operations.length !== 1) continue;
  const operation = tx.operations[0];
  if (operation?.type !== "invokeHostFunction") continue;
  if (
    operation.func.switch().name === "hostFunctionTypeCreateContractV2" &&
    result.returnValue
  ) {
    const id = scValToNative(result.returnValue);
    if (id === profile.kernel) deploymentTransactions.kernel = row.hash;
    if (id === deployment.hook) deploymentTransactions.hook = row.hash;
  } else if (
    operation.func.switch().name === "hostFunctionTypeInvokeContract"
  ) {
    const call = operation.func.invokeContract();
    if (
      Address.fromScAddress(call.contractAddress()).toString() ===
        profile.kernel &&
      call.functionName().toString() === "set_hook" &&
      scValToNative(call.args()[0]!) === deployment.hook &&
      scValToNative(call.args()[1]!) === true
    )
      deploymentTransactions.admission = row.hash;
  }
}
const receipts = [];
const report = JSON.parse(
  await readFile(resolve(dir, "pilot/author-run-report.json"), "utf8"),
) as { scenarios: { jobId: string; balanceAccounting: BalanceAccounting }[] };
const runIds = new Set(report.scenarios.map((s) => s.jobId));
for (const name of (await readdir(resolve(dir, "pilot"))).filter((name) =>
  /^job-\d+\.json$/.test(name),
)) {
  const file = await parseReceipt(
    await readFile(resolve(dir, "pilot", name), "utf8"),
  );
  if (runIds.has(file.receipt.jobId)) receipts.push(file);
}
const execute = promisify(execFile);
function decodeInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
): unknown {
  const fn = invocation.function();
  const children = invocation.subInvocations().map(decodeInvocation);
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn")
    return {
      type: fn.switch().name,
      functionXdr: fn.toXDR("base64"),
      children,
    };
  const call = fn.contractFn();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    method: call.functionName().toString(),
    arguments: call.args().map((arg) => scValToNative(arg) as unknown),
    children,
  };
}
const version = async (program: string, args: string[]) =>
  (await execute(program, args)).stdout.trim();
const evidence: CanaryEvidence = {
  schema: "stellar-8183/canary-evidence/v1",
  profile,
  sourceCommit: deployment.sourceCommit,
  hook: deployment.hook,
  kernelWasmSha256: deployment.wasmSha256.commerce,
  hookWasmSha256: deployment.wasmSha256.sla_hook,
  deploymentTransactions,
  receipts,
  evidenceType: "author-run",
  independentParticipant: false,
  toolchain: {
    rustc: await version("rustc", ["--version"]),
    stellarCli: await version("stellar", ["--version"]),
    node: process.version,
    pnpm: "pnpm@11.9.0",
    sorobanSdk: "27.0.3",
    stellarSdk: "16.2.0",
  },
  balanceAccounting: report.scenarios.map((s) => s.balanceAccounting),
};
const text = encodeCanaryEvidence(evidence);
await parseCanaryEvidence(text);
for (const hash of [
  ...Object.values(deploymentTransactions),
  ...receipts.map((r) => r.receipt.terminalTransaction.hash),
  ...evidence.balanceAccounting.map((b) => b.fundingTransaction),
]) {
  const tx = await reader.server.getTransaction(hash);
  if (tx.status !== "SUCCESS")
    throw new Error("Capture only successful transactions.");
  const envelope = TransactionBuilder.fromXDR(
    tx.envelopeXdr,
    profile.networkPassphrase,
  );
  if (!(envelope instanceof Transaction))
    throw new Error("Unexpected fee-bump envelope in author-run evidence.");
  const events = tx.events.contractEventsXdr.flat();
  archive.push({
    hash,
    ledger: tx.ledger,
    envelopeXdr: tx.envelopeXdr.toXDR("base64"),
    resultXdr: tx.resultXdr.toXDR("base64"),
    resultMetaXdr: tx.resultMetaXdr.toXDR("base64"),
    events: events.map((event) => event.toXDR("base64")),
    decodedEvents: events
      .filter((event) => event.contractId() !== null)
      .map((event) => decodeContractEvent(event.toXDR("base64"))),
    decodedAuthorizations: envelope.operations.flatMap((op) =>
      op.type !== "invokeHostFunction"
        ? []
        : (op.auth ?? []).map((entry) => {
            const credentials = entry.credentials();
            const address =
              credentials.switch().name === "sorobanCredentialsAddress"
                ? Address.fromScAddress(
                    credentials.address().address(),
                  ).toString()
                : envelope.source;
            return {
              credentialType: credentials.switch().name,
              address,
              invocation: decodeInvocation(entry.rootInvocation()),
            };
          }),
    ),
  });
}
await mkdir(dir, { recursive: true });
await writeFile(resolve(dir, "canary-evidence.json"), text);
await writeFile(
  resolve(dir, "canary-evidence.json.sha256"),
  `${await digestText(text)}  canary-evidence.json\n`,
);
await writeFile(
  resolve(dir, "transaction-archive.json"),
  JSON.stringify(
    {
      schema: "stellar-8183/public-transaction-archive/v1",
      evidenceType: "author-run",
      transactions: archive,
    },
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  ),
);
console.log(
  `Captured ${receipts.length} terminal jobs, deployment transactions, and public XDR evidence. No independent participant is claimed.`,
);
