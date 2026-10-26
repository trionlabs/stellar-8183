import {
  canonicalJson,
  type CanonicalJsonValue,
  type Job,
} from "@trionlabs/stellar-8183";
import {
  address,
  contract,
  hex,
  terminal,
  uint,
  validateProfile,
  type AgentBinding,
  type Outcome,
  type Profile,
} from "./model.js";
import { assertBinding } from "./identity.js";

export interface OutcomeReceipt {
  schema: "stellar-8183/outcome/v1";
  network: Profile["id"];
  networkPassphrase: string;
  kernel: string;
  token: string;
  jobId: string;
  client: string;
  provider: string | null;
  evaluator: string;
  budget: string;
  expiresAt: string;
  description: string;
  hook: string | null;
  state: "Completed" | "Rejected" | "Expired";
  workHash: string | null;
  decision: string | null;
  terminalTransaction: Outcome;
  agentBinding: AgentBinding | null;
  evidenceType: "on-chain";
}
export interface ReceiptFile {
  receipt: OutcomeReceipt;
  sha256: string;
}
const canonical = (value: unknown): string =>
  canonicalJson(value as CanonicalJsonValue);
export async function digest(value: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer),
    ),
  );
}
export const digestText = (value: string): Promise<string> =>
  digest(new TextEncoder().encode(value));
export async function makeReceipt(
  profile: Profile,
  job: Job,
  outcome: Outcome,
  binding?: AgentBinding,
): Promise<ReceiptFile> {
  if (binding) assertBinding(profile, binding, job.provider ?? "");
  if (!terminal(job.state.tag))
    throw new Error("Receipts require a terminal job.");
  const receipt: OutcomeReceipt = {
    schema: "stellar-8183/outcome/v1",
    network: profile.id,
    networkPassphrase: profile.networkPassphrase,
    kernel: profile.kernel,
    token: profile.token,
    jobId: job.id.toString(),
    client: job.client,
    provider: job.provider ?? null,
    evaluator: job.evaluator,
    budget: job.budget.toString(),
    expiresAt: job.expires_at.toString(),
    description: job.desc,
    hook: job.hook ?? null,
    state: job.state.tag as OutcomeReceipt["state"],
    workHash: job.work_hash ? hex(job.work_hash) : null,
    decision: job.decision ? hex(job.decision) : null,
    terminalTransaction: outcome,
    agentBinding: binding ?? null,
    evidenceType: "on-chain",
  };
  return { receipt, sha256: await digestText(canonical(receipt)) };
}
export function encodeReceipt(file: ReceiptFile): string {
  return canonical(file);
}
export async function parseReceipt(text: string): Promise<ReceiptFile> {
  if (text.length > 64_000) throw new Error("Receipt exceeds 64 KB.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid receipt file.");
  const file = value as ReceiptFile;
  const r = file.receipt;
  if (
    !r ||
    r.schema !== "stellar-8183/outcome/v1" ||
    r.evidenceType !== "on-chain"
  )
    throw new Error("Unknown receipt schema.");
  if (Object.keys(file).sort().join() !== "receipt,sha256")
    throw new Error("Unexpected receipt envelope fields.");
  const fields = [
    "schema",
    "network",
    "networkPassphrase",
    "kernel",
    "token",
    "jobId",
    "client",
    "provider",
    "evaluator",
    "budget",
    "expiresAt",
    "description",
    "hook",
    "state",
    "workHash",
    "decision",
    "terminalTransaction",
    "agentBinding",
    "evidenceType",
  ];
  if (Object.keys(r).sort().join() !== fields.sort().join())
    throw new Error("Unexpected or missing receipt fields.");
  validateProfile({
    id: r.network,
    networkPassphrase: r.networkPassphrase,
    rpcUrl: "https://example.org",
    kernel: r.kernel,
    token: r.token,
    symbol: r.network === "mainnet-canary" ? "DEMO8183" : "TEST",
    decimals: 7,
    maxFee: "100",
    canaryAcknowledged: true,
  });
  address(r.client);
  address(r.evaluator);
  if (r.provider !== null) address(r.provider);
  if (r.hook !== null) contract(r.hook);
  uint(r.jobId);
  uint(r.expiresAt);
  if (
    typeof r.budget !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(r.budget) ||
    BigInt(r.budget) > (1n << 127n) - 1n
  )
    throw new Error("Invalid receipt budget.");
  if (
    typeof r.description !== "string" ||
    new TextEncoder().encode(r.description).length > 512 ||
    !terminal(r.state)
  )
    throw new Error("Invalid receipt job.");
  for (const commitment of [r.workHash, r.decision])
    if (commitment !== null && !/^[a-f0-9]{64}$/.test(commitment))
      throw new Error("Invalid commitment.");
  const tx = r.terminalTransaction;
  if (
    !tx ||
    Object.keys(tx).sort().join() !== "hash,ledger,method" ||
    !/^[a-f0-9]{64}$/.test(tx.hash) ||
    !Number.isSafeInteger(tx.ledger) ||
    tx.ledger <= 0 ||
    !["complete", "reject", "claim_refund"].includes(tx.method)
  )
    throw new Error("Invalid terminal transaction.");
  const method = {
    Completed: "complete",
    Rejected: "reject",
    Expired: "claim_refund",
  }[r.state];
  if (tx.method !== method)
    throw new Error("Terminal method does not match state.");
  if (r.agentBinding !== null) {
    const b = r.agentBinding;
    if (
      Object.keys(b).sort().join() !==
        "agentId,identityRegistry,network,provider,resolvedAtLedger" ||
      b.network !== r.network ||
      b.provider !== r.provider ||
      !Number.isSafeInteger(b.resolvedAtLedger) ||
      b.resolvedAtLedger <= 0 ||
      uint(b.agentId) > 0xffff_ffffn
    )
      throw new Error("Invalid agent binding.");
    contract(b.identityRegistry);
    address(b.provider);
  }
  if (file.sha256 !== (await digestText(canonical(r))))
    throw new Error(
      "Receipt content hash does not match. The file was changed or corrupted.",
    );
  return file;
}

export function matchReceiptJob(r: OutcomeReceipt, job: Job): void {
  const actual = [
    job.id.toString(),
    job.client,
    job.provider ?? null,
    job.evaluator,
    job.budget.toString(),
    job.expires_at.toString(),
    job.desc,
    job.hook ?? null,
    job.state.tag,
    job.work_hash ? hex(job.work_hash) : null,
    job.decision ? hex(job.decision) : null,
  ];
  const expected = [
    r.jobId,
    r.client,
    r.provider,
    r.evaluator,
    r.budget,
    r.expiresAt,
    r.description,
    r.hook,
    r.state,
    r.workHash,
    r.decision,
  ];
  if (canonical(actual) !== canonical(expected))
    throw new Error("Receipt does not match the terminal on-chain job.");
}
