import { Address, Networks, StrKey } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits, type Job } from "@trionlabs/stellar-8183";

export type State = Job["state"]["tag"];
export type Action =
  | "set_provider"
  | "set_budget"
  | "fund"
  | "submit"
  | "complete"
  | "reject"
  | "claim_refund";
export type Role = "client" | "provider" | "evaluator";
export interface Profile {
  id: "testnet" | "mainnet-canary";
  rpcUrl: string;
  networkPassphrase: string;
  kernel: string;
  token: string;
  symbol: string;
  decimals: number;
  maxFee: string;
  canaryAcknowledged: boolean;
}
export interface AgentRef {
  network: Profile["id"];
  identityRegistry: string;
  agentId: string;
}
export interface AgentBinding extends AgentRef {
  provider: string;
  resolvedAtLedger: number;
}
export interface Outcome {
  hash: string;
  ledger: number;
  method: string;
}
export interface RecordJob {
  job: Job;
  binding?: AgentBinding;
  outcome?: Outcome;
}
export const PASS = {
  testnet: Networks.TESTNET,
  "mainnet-canary": Networks.PUBLIC,
};
export const EXPLORER = { testnet: "testnet", "mainnet-canary": "public" };
export const terminal = (state: State): boolean =>
  ["Completed", "Rejected", "Expired"].includes(state);
export const address = (value: string): string => {
  Address.fromString(value);
  return value;
};
export function contract(value: string): string {
  if (!StrKey.isValidContract(value))
    throw new Error("Enter a valid contract address beginning with C.");
  return value;
}
export function uint(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Enter a whole, non-negative job or agent ID.");
  const id = BigInt(value);
  if (id > (1n << 64n) - 1n) throw new Error("ID exceeds u64.");
  return id;
}
export function validateProfile(profile: Profile): Profile {
  const fields = [
    "id",
    "rpcUrl",
    "networkPassphrase",
    "kernel",
    "token",
    "symbol",
    "decimals",
    "maxFee",
    "canaryAcknowledged",
  ];
  if (
    !profile ||
    typeof profile !== "object" ||
    Object.keys(profile).sort().join() !== fields.sort().join()
  )
    throw new Error("Unexpected or missing deployment profile fields.");
  for (const key of [
    "id",
    "rpcUrl",
    "networkPassphrase",
    "kernel",
    "token",
    "symbol",
    "maxFee",
  ] as const)
    if (typeof profile[key] !== "string")
      throw new Error(`Invalid profile field: ${key}.`);
  if (typeof profile.canaryAcknowledged !== "boolean")
    throw new Error("Canary acknowledgement must be a boolean.");
  contract(profile.kernel);
  contract(profile.token);
  if (
    !Object.hasOwn(PASS, profile.id) ||
    profile.networkPassphrase !== PASS[profile.id]
  )
    throw new Error("Network profile and passphrase do not match.");
  const url = new URL(profile.rpcUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS for the Stellar RPC.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("RPC credentials do not belong in public configuration.");
  if (
    !Number.isInteger(profile.decimals) ||
    profile.decimals < 0 ||
    profile.decimals > 18
  )
    throw new Error("Token decimals must be between 0 and 18.");
  if (
    !/^[1-9][0-9]*$/.test(profile.maxFee) ||
    BigInt(profile.maxFee) > 100_000_000n
  )
    throw new Error("Fee ceiling must be positive and at most 10 XLM.");
  if (
    profile.id === "mainnet-canary" &&
    (!profile.canaryAcknowledged || profile.symbol !== "DEMO8183")
  )
    throw new Error(
      "Mainnet is restricted to the acknowledged DEMO8183 canary profile.",
    );
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(profile.symbol))
    throw new Error("Invalid token symbol.");
  return profile;
}
export function availableActions(
  job: Job,
  actor: string,
  now = Math.floor(Date.now() / 1000),
): Action[] {
  const state = job.state.tag;
  if (terminal(state)) return [];
  const actions: Action[] = [];
  if (state === "Open") {
    if (actor === job.client)
      actions.push("set_provider", "set_budget", "reject");
    else if (actor === job.provider) actions.push("set_budget");
    if (
      actor === job.client &&
      job.provider &&
      job.budget > 0n &&
      BigInt(now) < job.expires_at
    )
      actions.push("fund");
  }
  if (state === "Funded" && actor === job.provider) actions.push("submit");
  if ((state === "Funded" || state === "Submitted") && actor === job.evaluator)
    actions.push("reject");
  if (state === "Submitted" && actor === job.evaluator)
    actions.push("complete");
  if (
    (state === "Funded" || state === "Submitted") &&
    BigInt(now) >= job.expires_at
  )
    actions.push("claim_refund");
  return actions;
}
export function assertAction(
  job: Job,
  action: Action,
  actor: string,
  now?: number,
): void {
  if (!availableActions(job, actor, now).includes(action))
    throw new Error(
      "This wallet cannot perform that action in the current job state. Refresh the job and check its role and expiry.",
    );
}

export function assertReviewedJob(current: Job, reviewed: Job): void {
  const terms = (job: Job): string =>
    JSON.stringify(
      [
        job.id,
        job.client,
        job.provider ?? "",
        job.evaluator,
        job.budget,
        job.expires_at,
        job.hook ?? "",
        job.state.tag,
        job.desc,
        job.work_hash ? hex(job.work_hash) : "",
      ].map(String),
    );
  if (terms(current) !== terms(reviewed))
    throw new Error(
      "Job terms changed after your review. Refresh and review the updated job before signing.",
    );
}
export function amount(value: string, decimals: number): bigint {
  const result = parseUnits(value, decimals);
  if (result <= 0n) throw new Error("Budget must be greater than zero.");
  return result;
}
export const displayAmount = (value: bigint, decimals: number): string =>
  formatUnits(value, decimals);
export function explorer(
  profile: Profile,
  type: "tx" | "contract",
  id: string,
): string {
  if (type === "tx" && !/^[a-f0-9]{64}$/.test(id))
    throw new Error("Invalid transaction hash.");
  if (type === "contract") contract(id);
  return `https://stellar.expert/explorer/${EXPLORER[profile.id]}/${type}/${id}`;
}
export const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
