import {
  canonicalJson,
  type CanonicalJsonValue,
} from "@trionlabs/stellar-8183";
import { contract, validateProfile, type Profile } from "./model.js";
import { parseReceipt, type ReceiptFile } from "./receipt.js";
import {
  verifyBalanceAccounting,
  type BalanceAccounting,
} from "./accounting.js";

export interface CanaryEvidence {
  schema: "stellar-8183/canary-evidence/v1";
  profile: Profile;
  sourceCommit: string;
  hook: string;
  kernelWasmSha256: string;
  hookWasmSha256: string;
  deploymentTransactions: { kernel: string; hook: string; admission: string };
  receipts: ReceiptFile[];
  evidenceType: "author-run";
  independentParticipant: false;
  toolchain: {
    rustc: string;
    stellarCli: string;
    node: string;
    pnpm: string;
    sorobanSdk: string;
    stellarSdk: string;
  };
  balanceAccounting: BalanceAccounting[];
}
export async function parseCanaryEvidence(
  text: string,
): Promise<CanaryEvidence> {
  if (text.length > 1_000_000) throw new Error("Evidence exceeds 1 MB.");
  const evidence = JSON.parse(text) as CanaryEvidence;
  if (
    !evidence ||
    evidence.schema !== "stellar-8183/canary-evidence/v1" ||
    evidence.evidenceType !== "author-run" ||
    evidence.independentParticipant !== false
  )
    throw new Error("Unsupported canary evidence profile.");
  const allowed = [
    "schema",
    "profile",
    "sourceCommit",
    "hook",
    "kernelWasmSha256",
    "hookWasmSha256",
    "deploymentTransactions",
    "receipts",
    "evidenceType",
    "independentParticipant",
    "toolchain",
    "balanceAccounting",
  ];
  if (Object.keys(evidence).sort().join() !== allowed.sort().join())
    throw new Error("Unexpected canary evidence fields.");
  validateProfile(evidence.profile);
  contract(evidence.hook);
  if (
    !evidence.toolchain ||
    Object.keys(evidence.toolchain).sort().join() !==
      "node,pnpm,rustc,sorobanSdk,stellarCli,stellarSdk" ||
    !/^rustc 1\.96\.0\b/.test(evidence.toolchain.rustc) ||
    !/^stellar 27\.0\.0\b/.test(evidence.toolchain.stellarCli) ||
    evidence.toolchain.pnpm !== "pnpm@11.9.0" ||
    evidence.toolchain.sorobanSdk !== "27.0.3" ||
    evidence.toolchain.stellarSdk !== "16.2.0" ||
    !/^v[0-9]+\./.test(evidence.toolchain.node)
  )
    throw new Error("Canary evidence must record the pinned build toolchain.");
  if (
    !Array.isArray(evidence.balanceAccounting) ||
    evidence.balanceAccounting.length !== evidence.receipts.length
  )
    throw new Error("Every receipt needs exact balance accounting.");
  if (!/^[a-f0-9]{40}$/.test(evidence.sourceCommit))
    throw new Error("Pin a complete source commit.");
  for (const hash of [
    evidence.kernelWasmSha256,
    evidence.hookWasmSha256,
    ...Object.values(evidence.deploymentTransactions),
  ])
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid evidence hash.");
  if (
    Object.keys(evidence.deploymentTransactions).sort().join() !==
    "admission,hook,kernel"
  )
    throw new Error("Missing deployment transactions.");
  if (
    !Array.isArray(evidence.receipts) ||
    evidence.receipts.length < 3 ||
    evidence.receipts.length > 100
  )
    throw new Error("Provide at least three terminal receipts.");
  const paths = new Set<string>(),
    jobs = new Set<string>(),
    txs = new Set<string>();
  for (const input of evidence.receipts) {
    const { receipt } = await parseReceipt(JSON.stringify(input));
    if (
      receipt.evidenceType !== "on-chain" ||
      receipt.kernel !== evidence.profile.kernel ||
      receipt.token !== evidence.profile.token ||
      receipt.network !== evidence.profile.id
    )
      throw new Error("Canary receipt targets a different deployment.");
    if (jobs.has(receipt.jobId) || txs.has(receipt.terminalTransaction.hash))
      throw new Error(
        "Duplicate job or terminal transaction in canary evidence.",
      );
    jobs.add(receipt.jobId);
    txs.add(receipt.terminalTransaction.hash);
    paths.add(receipt.state);
    if (receipt.budget === "0" || !receipt.provider)
      throw new Error("Canary scenarios must include funded jobs.");
    const balances = evidence.balanceAccounting.filter(
      (b) => b.jobId === receipt.jobId,
    );
    if (
      balances.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(balances[0]!.fundingTransaction)
    )
      throw new Error("Missing or duplicate funding evidence.");
    verifyBalanceAccounting(
      balances[0]!,
      BigInt(receipt.budget),
      receipt.state === "Completed",
    );
  }
  if (!["Completed", "Rejected", "Expired"].every((path) => paths.has(path)))
    throw new Error(
      "Evidence must cover completion, funded rejection, and expired refund.",
    );
  return evidence;
}
export const encodeCanaryEvidence = (evidence: CanaryEvidence): string =>
  canonicalJson(evidence as unknown as CanonicalJsonValue);
