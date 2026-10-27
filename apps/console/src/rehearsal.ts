import { StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { commitmentFromHex, type Job } from "@trionlabs/stellar-8183";
import {
  address,
  assertAction,
  type Action,
  type Profile,
  type RecordJob,
  PASS,
} from "./model.js";
import { digestText } from "./receipt.js";
import type { ActionInput, NewJob } from "./live.js";

export const rehearsalAccounts = {
  client: "GCWCFRHVSL6JRXUF45RNEYLU6LU3WVH6SWSLJAMS5PZWZCL6FKEDSZSI",
  provider: "GAZGIM5UT5YU2BHC35QNWHMMGZLL6LZYWPXCMH75UZYFQSBEGWMVGG2T",
  evaluator: "GBQYUXOJJQBFVPJZEA4FUVVTG4YOF7OCOIYHT4QOHE5G4W2MGNLGGKQJ",
};
export const rehearsalProfile: Profile = {
  id: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: PASS.testnet,
  kernel: StrKey.encodeContract(Buffer.alloc(32, 201)),
  token: StrKey.encodeContract(Buffer.alloc(32, 202)),
  symbol: "DEMO8183",
  decimals: 7,
  maxFee: "1000000",
  canaryAcknowledged: false,
};
export class Rehearsal {
  private jobs = new Map<bigint, RecordJob>();
  private next = 1n;
  private step = 0;
  now = Math.floor(Date.now() / 1000);
  balances = new Map(
    Object.values(rehearsalAccounts).map((account) => [account, 1000_0000000n]),
  );
  escrow = 0n;
  create(input: NewJob, client: string): RecordJob {
    if (
      new TextEncoder().encode(input.description).length < 1 ||
      new TextEncoder().encode(input.description).length > 512
    )
      throw new Error("Description must contain 1-512 UTF-8 bytes.");
    address(client);
    address(input.evaluator);
    if (input.provider) address(input.provider);
    if (input.expiresAt <= BigInt(this.now))
      throw new Error("Choose a future expiry.");
    const job: Job = {
      id: this.next++,
      client,
      provider: input.provider,
      evaluator: input.evaluator,
      expires_at: input.expiresAt,
      desc: input.description,
      budget: 0n,
      state: { tag: "Open", values: undefined },
      hook: undefined,
      work_hash: undefined,
      decision: undefined,
    };
    const record = { job };
    this.jobs.set(job.id, record);
    return structuredClone(record);
  }
  read(id: bigint): RecordJob {
    const record = this.jobs.get(id);
    if (!record) throw new Error("Job not found in this rehearsal.");
    return structuredClone(record);
  }
  async act(
    id: bigint,
    action: Action,
    actor: string,
    input: ActionInput = {},
  ): Promise<RecordJob> {
    const record = this.read(id),
      job = record.job;
    assertAction(job, action, actor, this.now);
    let state = job.state.tag;
    let next = { ...job };
    switch (action) {
      case "set_provider":
        next.provider = address(input.provider ?? "");
        break;
      case "set_budget":
        if (!input.budget || input.budget <= 0n)
          throw new Error("Budget must be positive.");
        next.budget = input.budget;
        break;
      case "fund": {
        const balance = this.balances.get(job.client) ?? 0n;
        if (balance < job.budget)
          throw new Error("Insufficient rehearsal balance.");
        this.balances.set(job.client, balance - job.budget);
        this.escrow += job.budget;
        state = "Funded";
        break;
      }
      case "submit":
        next.work_hash = commitmentFromHex(input.commitment ?? "");
        state = "Submitted";
        break;
      case "complete":
        state = "Completed";
        break;
      case "reject":
        state = "Rejected";
        break;
      case "claim_refund":
        state = "Expired";
        break;
    }
    if (action === "complete" || action === "reject")
      next.decision = input.commitment
        ? commitmentFromHex(input.commitment)
        : undefined;
    if (
      ["Completed", "Rejected", "Expired"].includes(state) &&
      job.state.tag !== "Open"
    ) {
      const payee = state === "Completed" ? job.provider! : job.client;
      this.balances.set(payee, (this.balances.get(payee) ?? 0n) + job.budget);
      this.escrow -= job.budget;
    }
    next = { ...next, state: { tag: state, values: undefined } };
    const updated = {
      job: next,
      outcome: {
        hash: await digestText(`rehearsal:${++this.step}:${id}:${action}`),
        ledger: this.step,
        method: action,
      },
    };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }
}
