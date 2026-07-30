import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}





/**
 * A complete, independently archived job record.
 */
export interface Job {
  budget: i128;
  client: string;
  decision: Option<Buffer>;
  desc: string;
  evaluator: string;
  expires_at: u64;
  hook: Option<string>;
  id: u64;
  provider: Option<string>;
  state: JobState;
  work_hash: Option<Buffer>;
}

/**
 * Stable kernel error codes. These values are part of the public ABI.
 */
export const Errors = {
  1: {message:"NotFound"},
  2: {message:"BadState"},
  3: {message:"BadActor"},
  4: {message:"BadExpiry"},
  5: {message:"BadDesc"},
  6: {message:"BadBudget"},
  7: {message:"NoProvider"},
  8: {message:"BudgetDiff"},
  9: {message:"HookDenied"},
  10: {message:"IdOverflow"},
  11: {message:"NoPending"},
  12: {message:"OptTooLong"},
  13: {message:"ProvExists"}
}

/**
 * A hookable kernel action.
 */
export type Action = {tag: "SetProv", values: void} | {tag: "SetBudget", values: void} | {tag: "Fund", values: void} | {tag: "Submit", values: void} | {tag: "Complete", values: void} | {tag: "Reject", values: void};

/**
 * The action-specific value passed to a hook.
 */
export type HookArg = {tag: "None", values: void} | {tag: "Provider", values: readonly [string]} | {tag: "Budget", values: readonly [i128]} | {tag: "Work", values: readonly [Buffer]} | {tag: "Decision", values: readonly [Option<Buffer>]};


/**
 * A callback snapshot. Before callbacks receive the pre-action job state and
 * after callbacks receive the post-action state.
 */
export interface HookCtx {
  action: Action;
  actor: string;
  arg: HookArg;
  budget: i128;
  client: string;
  evaluator: string;
  expiry: u64;
  job_id: u64;
  opt: Buffer;
  provider: Option<string>;
  state: JobState;
}




/**
 * The six states required by ERC-8183.
 */
export type JobState = {tag: "Open", values: void} | {tag: "Funded", values: void} | {tag: "Submitted", values: void} | {tag: "Completed", values: void} | {tag: "Rejected", values: void} | {tag: "Expired", values: void};











export interface Client {
  /**
   * Construct and simulate a fund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  fund: ({id, expected_budget, opt}: {id: u64, expected_budget: i128, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reject transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  reject: ({id, reason, opt}: {id: u64, reason: Option<Buffer>, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a submit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit: ({id, work_hash, opt}: {id: u64, work_hash: Buffer, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_job transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_job: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Job>>>

  /**
   * Construct and simulate a is_hook transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_hook: ({hook}: {hook: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a complete transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  complete: ({id, reason, opt}: {id: u64, reason: Option<Buffer>, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_hook transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_hook: ({hook, allowed}: {hook: string, allowed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a get_token transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_token: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a job_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  job_count: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a create_job transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  create_job: ({client, provider, evaluator, expires_at, desc, hook}: {client: string, provider: Option<string>, evaluator: string, expires_at: u64, desc: string, hook: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a keep_alive transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  keep_alive: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_budget transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_budget: ({id, actor, amount, opt}: {id: u64, actor: string, amount: i128, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless and deliberately not hookable.
   */
  claim_refund: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_provider transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_provider: ({id, provider, opt}: {id: u64, provider: string, opt: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a propose_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose_admin: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static override async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, token}: {admin: string, token: string},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, token}, options)
  }
  constructor(public override readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAAAAAAAEZnVuZAAAAAMAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAA9leHBlY3RlZF9idWRnZXQAAAAACwAAAAAAAAADb3B0AAAAAA4AAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAGcmVqZWN0AAAAAAADAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAGcmVhc29uAAAAAAPoAAAD7gAAACAAAAAAAAAAA29wdAAAAAAOAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAGc3VibWl0AAAAAAADAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAJd29ya19oYXNoAAAAAAAD7gAAACAAAAAAAAAAA29wdAAAAAAOAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAHZ2V0X2pvYgAAAAABAAAAAAAAAAJpZAAAAAAABgAAAAEAAAPpAAAH0AAAAANKb2IAAAAAAw==",
        "AAAAAAAAAAAAAAAHaXNfaG9vawAAAAABAAAAAAAAAARob29rAAAAEwAAAAEAAAAB",
        "AAAAAAAAAAAAAAAIY29tcGxldGUAAAADAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAGcmVhc29uAAAAAAPoAAAD7gAAACAAAAAAAAAAA29wdAAAAAAOAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAIc2V0X2hvb2sAAAACAAAAAAAAAARob29rAAAAEwAAAAAAAAAHYWxsb3dlZAAAAAABAAAAAA==",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJZ2V0X3Rva2VuAAAAAAAAAAAAAAEAAAAT",
        "AAAAAAAAAAAAAAAJam9iX2NvdW50AAAAAAAAAAAAAAEAAAAG",
        "AAAAAAAAAAAAAAAKY3JlYXRlX2pvYgAAAAAABgAAAAAAAAAGY2xpZW50AAAAAAATAAAAAAAAAAhwcm92aWRlcgAAA+gAAAATAAAAAAAAAAlldmFsdWF0b3IAAAAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAARkZXNjAAAAEAAAAAAAAAAEaG9vawAAA+gAAAATAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAAAAAAAKa2VlcF9hbGl2ZQAAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAKc2V0X2J1ZGdldAAAAAAABAAAAAAAAAACaWQAAAAAAAYAAAAAAAAABWFjdG9yAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAANvcHQAAAAADgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAMYWNjZXB0X2FkbWluAAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAC1QZXJtaXNzaW9ubGVzcyBhbmQgZGVsaWJlcmF0ZWx5IG5vdCBob29rYWJsZS4AAAAAAAAMY2xhaW1fcmVmdW5kAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAMc2V0X3Byb3ZpZGVyAAAAAwAAAAAAAAACaWQAAAAAAAYAAAAAAAAACHByb3ZpZGVyAAAAEwAAAAAAAAADb3B0AAAAAA4AAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAANcHJvcG9zZV9hZG1pbgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAQAAAC5BIGNvbXBsZXRlLCBpbmRlcGVuZGVudGx5IGFyY2hpdmVkIGpvYiByZWNvcmQuAAAAAAAAAAAAA0pvYgAAAAALAAAAAAAAAAZidWRnZXQAAAAAAAsAAAAAAAAABmNsaWVudAAAAAAAEwAAAAAAAAAIZGVjaXNpb24AAAPoAAAD7gAAACAAAAAAAAAABGRlc2MAAAAQAAAAAAAAAAlldmFsdWF0b3IAAAAAAAATAAAAAAAAAApleHBpcmVzX2F0AAAAAAAGAAAAAAAAAARob29rAAAD6AAAABMAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAAhwcm92aWRlcgAAA+gAAAATAAAAAAAAAAVzdGF0ZQAAAAAAB9AAAAAISm9iU3RhdGUAAAAAAAAACXdvcmtfaGFzaAAAAAAAA+gAAAPuAAAAIA==",
        "AAAABAAAAENTdGFibGUga2VybmVsIGVycm9yIGNvZGVzLiBUaGVzZSB2YWx1ZXMgYXJlIHBhcnQgb2YgdGhlIHB1YmxpYyBBQkkuAAAAAAAAAAAFRXJyb3IAAAAAAAANAAAAAAAAAAhOb3RGb3VuZAAAAAEAAAAAAAAACEJhZFN0YXRlAAAAAgAAAAAAAAAIQmFkQWN0b3IAAAADAAAAAAAAAAlCYWRFeHBpcnkAAAAAAAAEAAAAAAAAAAdCYWREZXNjAAAAAAUAAAAAAAAACUJhZEJ1ZGdldAAAAAAAAAYAAAAAAAAACk5vUHJvdmlkZXIAAAAAAAcAAAAAAAAACkJ1ZGdldERpZmYAAAAAAAgAAAAAAAAACkhvb2tEZW5pZWQAAAAAAAkAAAAAAAAACklkT3ZlcmZsb3cAAAAAAAoAAAAAAAAACU5vUGVuZGluZwAAAAAAAAsAAAAAAAAACk9wdFRvb0xvbmcAAAAAAAwAAAAAAAAAClByb3ZFeGlzdHMAAAAAAA0=",
        "AAAAAgAAABlBIGhvb2thYmxlIGtlcm5lbCBhY3Rpb24uAAAAAAAAAAAAAAZBY3Rpb24AAAAAAAYAAAAAAAAAAAAAAAdTZXRQcm92AAAAAAAAAAAAAAAACVNldEJ1ZGdldAAAAAAAAAAAAAAAAAAABEZ1bmQAAAAAAAAAAAAAAAZTdWJtaXQAAAAAAAAAAAAAAAAACENvbXBsZXRlAAAAAAAAAAAAAAAGUmVqZWN0AAA=",
        "AAAAAgAAACtUaGUgYWN0aW9uLXNwZWNpZmljIHZhbHVlIHBhc3NlZCB0byBhIGhvb2suAAAAAAAAAAAHSG9va0FyZwAAAAAFAAAAAAAAAAAAAAAETm9uZQAAAAEAAAAAAAAACFByb3ZpZGVyAAAAAQAAABMAAAABAAAAAAAAAAZCdWRnZXQAAAAAAAEAAAALAAAAAQAAAAAAAAAEV29yawAAAAEAAAPuAAAAIAAAAAEAAAAAAAAACERlY2lzaW9uAAAAAQAAA+gAAAPuAAAAIA==",
        "AAAAAQAAAHlBIGNhbGxiYWNrIHNuYXBzaG90LiBCZWZvcmUgY2FsbGJhY2tzIHJlY2VpdmUgdGhlIHByZS1hY3Rpb24gam9iIHN0YXRlIGFuZAphZnRlciBjYWxsYmFja3MgcmVjZWl2ZSB0aGUgcG9zdC1hY3Rpb24gc3RhdGUuAAAAAAAAAAAAAAdIb29rQ3R4AAAAAAsAAAAAAAAABmFjdGlvbgAAAAAH0AAAAAZBY3Rpb24AAAAAAAAAAAAFYWN0b3IAAAAAAAATAAAAAAAAAANhcmcAAAAH0AAAAAdIb29rQXJnAAAAAAAAAAAGYnVkZ2V0AAAAAAALAAAAAAAAAAZjbGllbnQAAAAAABMAAAAAAAAACWV2YWx1YXRvcgAAAAAAABMAAAAAAAAABmV4cGlyeQAAAAAABgAAAAAAAAAGam9iX2lkAAAAAAAGAAAAAAAAAANvcHQAAAAADgAAAAAAAAAIcHJvdmlkZXIAAAPoAAAAEwAAAAAAAAAFc3RhdGUAAAAAAAfQAAAACEpvYlN0YXRl",
        "AAAABQAAAAAAAAAAAAAAB0hvb2tTZXQAAAAAAQAAAAhob29rX3NldAAAAAIAAAAAAAAABGhvb2sAAAATAAAAAQAAAAAAAAAHYWxsb3dlZAAAAAABAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAB0pvYkRvbmUAAAAAAQAAAA1qb2JfY29tcGxldGVkAAAAAAAAAwAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAlldmFsdWF0b3IAAAAAAAATAAAAAQAAAAAAAAAGcmVhc29uAAAAAAPoAAAD7gAAACAAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAB1Byb3ZTZXQAAAAAAQAAAAxwcm92aWRlcl9zZXQAAAACAAAAAAAAAAJpZAAAAAAABgAAAAEAAAAAAAAACHByb3ZpZGVyAAAAEwAAAAEAAAAC",
        "AAAAAgAAACRUaGUgc2l4IHN0YXRlcyByZXF1aXJlZCBieSBFUkMtODE4My4AAAAAAAAACEpvYlN0YXRlAAAABgAAAAAAAAAAAAAABE9wZW4AAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACVN1Ym1pdHRlZAAAAAAAAAAAAAAAAAAACUNvbXBsZXRlZAAAAAAAAAAAAAAAAAAACFJlamVjdGVkAAAAAAAAAAAAAAAHRXhwaXJlZAA=",
        "AAAABQAAAAAAAAAAAAAACEFkbWluU2V0AAAAAQAAAA5hZG1pbl9hY2NlcHRlZAAAAAAAAgAAAAAAAAAJb2xkX2FkbWluAAAAAAAAEwAAAAEAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACFJlZnVuZGVkAAAAAQAAAAhyZWZ1bmRlZAAAAAMAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAGY2xpZW50AAAAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAACUFkbWluUHJvcAAAAAAAAAEAAAAOYWRtaW5fcHJvcG9zZWQAAAAAAAIAAAAAAAAACW9sZF9hZG1pbgAAAAAAABMAAAABAAAAAAAAAAdwZW5kaW5nAAAAABMAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACUJ1ZGdldFNldAAAAAAAAAEAAAAKYnVkZ2V0X3NldAAAAAAAAwAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAVhY3RvcgAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACUpvYkV4cGlyZQAAAAAAAAEAAAALam9iX2V4cGlyZWQAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACUpvYkZ1bmRlZAAAAAAAAAEAAAAKam9iX2Z1bmRlZAAAAAAAAwAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAZjbGllbnQAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACUpvYlJlamVjdAAAAAAAAAEAAAAMam9iX3JlamVjdGVkAAAAAwAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAhyZWplY3RvcgAAABMAAAABAAAAAAAAAAZyZWFzb24AAAAAA+gAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACUpvYlN1Ym1pdAAAAAAAAAEAAAANam9iX3N1Ym1pdHRlZAAAAAAAAAMAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAIcHJvdmlkZXIAAAATAAAAAQAAAAAAAAAJd29ya19oYXNoAAAAAAAD7gAAACAAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAACkpvYkNyZWF0ZWQAAAAAAAEAAAALam9iX2NyZWF0ZWQAAAAABgAAAAAAAAACaWQAAAAAAAYAAAABAAAAAAAAAAZjbGllbnQAAAAAABMAAAABAAAAAAAAAAhwcm92aWRlcgAAA+gAAAATAAAAAAAAAAAAAAAJZXZhbHVhdG9yAAAAAAAAEwAAAAAAAAAAAAAACmV4cGlyZXNfYXQAAAAAAAYAAAAAAAAAAAAAAARob29rAAAD6AAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAClBheVJlbGVhc2UAAAAAAAEAAAAQcGF5bWVudF9yZWxlYXNlZAAAAAMAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAAIcHJvdmlkZXIAAAATAAAAAQAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAAI=" ]),
      options
    )
  }
  public readonly fromJSON = {
    fund: this.txFromJSON<Result<void>>,
        reject: this.txFromJSON<Result<void>>,
        submit: this.txFromJSON<Result<void>>,
        get_job: this.txFromJSON<Result<Job>>,
        is_hook: this.txFromJSON<boolean>,
        complete: this.txFromJSON<Result<void>>,
        set_hook: this.txFromJSON<null>,
        get_admin: this.txFromJSON<string>,
        get_token: this.txFromJSON<string>,
        job_count: this.txFromJSON<u64>,
        create_job: this.txFromJSON<Result<u64>>,
        keep_alive: this.txFromJSON<Result<void>>,
        set_budget: this.txFromJSON<Result<void>>,
        accept_admin: this.txFromJSON<Result<void>>,
        claim_refund: this.txFromJSON<Result<void>>,
        set_provider: this.txFromJSON<Result<void>>,
        propose_admin: this.txFromJSON<null>
  }
}
