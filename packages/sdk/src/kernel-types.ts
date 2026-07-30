import type {
  AssembledTransaction,
  ClientOptions,
  MethodOptions,
  SignAuthEntry,
  SignTransaction,
  Spec,
} from "@stellar/stellar-sdk/contract";
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractResult } from "./contract-result.js";

export type JobState =
  | { readonly tag: "Open"; readonly values: void }
  | { readonly tag: "Funded"; readonly values: void }
  | { readonly tag: "Submitted"; readonly values: void }
  | { readonly tag: "Completed"; readonly values: void }
  | { readonly tag: "Rejected"; readonly values: void }
  | { readonly tag: "Expired"; readonly values: void };

export interface Job {
  readonly id: bigint;
  readonly client: string;
  readonly provider: string | undefined;
  readonly evaluator: string;
  readonly desc: string;
  readonly budget: bigint;
  readonly expires_at: bigint;
  readonly state: JobState;
  readonly hook: string | undefined;
  readonly work_hash: Uint8Array | undefined;
  readonly decision: Uint8Array | undefined;
}

export type KernelMethod =
  | "create_job"
  | "set_provider"
  | "set_budget"
  | "fund"
  | "submit"
  | "complete"
  | "reject"
  | "claim_refund"
  | "get_job"
  | "keep_alive"
  | "propose_admin"
  | "accept_admin"
  | "set_hook"
  | "is_hook"
  | "get_token"
  | "get_admin"
  | "job_count";

export interface CreateJobArgs {
  readonly client: string;
  readonly provider?: string;
  readonly evaluator: string;
  readonly expiresAt: bigint;
  readonly description: string;
  readonly hook?: string;
}

export interface SetProviderArgs {
  readonly id: bigint;
  readonly provider: string;
  readonly options?: Uint8Array;
}

export interface SetBudgetArgs {
  readonly id: bigint;
  readonly actor: string;
  readonly amount: bigint;
  readonly options?: Uint8Array;
}

export interface FundArgs {
  readonly id: bigint;
  readonly expectedBudget: bigint;
  readonly options?: Uint8Array;
}

export interface SubmitArgs {
  readonly id: bigint;
  readonly workHash: Uint8Array;
  readonly options?: Uint8Array;
}

export interface DecideArgs {
  readonly id: bigint;
  readonly reason?: Uint8Array;
  readonly options?: Uint8Array;
}

export interface InvocationOptions {
  /** The fee-paying transaction source/facilitator. */
  readonly source: string;
  readonly fee?: string;
  readonly timeoutInSeconds?: number;
  /**
   * Enables Stellar SDK's separate restoreFootprint fallback only through an
   * exact-footprint, bounded-fee signing policy. Omit to disable that fallback.
   * Protocol-23 same-envelope archived entries are separate and are pinned by
   * RelayIntent when the relay workflow is used.
   */
  readonly restore?: GuardedRestoreOptions;
}

export interface ReadOptions {
  readonly source?: string;
  /** Optional guarded policy for Stellar SDK's separate restore transaction. */
  readonly restore?: GuardedRestoreOptions;
}

export interface AuthorizationSigner {
  readonly address: string;
  readonly signAuthEntry: SignAuthEntry;
}

export interface FacilitatorSigner {
  readonly address: string;
  readonly signTransaction: SignTransaction;
}

/**
 * Trusted policy for Stellar SDK's separate restore-footprint fallback.
 *
 * Populate `expectedLedgerKeyXdr` from independently derived ledger keys, not
 * from the same untrusted RPC response that requested restoration.
 */
export interface GuardedRestoreOptions {
  readonly signer: FacilitatorSigner;
  readonly networkPassphrase: string;
  readonly expectedLedgerKeyXdr: readonly string[];
  /** Hard ceiling for the complete restoration transaction fee, in stroops. */
  readonly maxFee: string;
  /** Defaults to 300 seconds and may not exceed 3,600. */
  readonly maxTransactionLifetimeSeconds?: number;
  /** Deterministic-test override; defaults to current wall-clock time. */
  readonly currentTime?: number;
}

/**
 * Minimal surface shared by runtime and generated clients.
 *
 * Generated clients inherit these members from Stellar's contract.Client.
 */
export interface KernelClientBase {
  readonly options: ClientOptions;
  readonly spec: Spec;
  txFromJSON<T>(json: string): AssembledTransaction<T>;
}

export interface PreparedInvocation<T> {
  readonly method: KernelMethod;
  readonly transaction: AssembledTransaction<T>;
}

export type PreparedContractInvocation<T> = PreparedInvocation<
  ContractResult<T>
>;

export interface KernelAdapter {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  invoke<T>(
    method: KernelMethod,
    args: Readonly<Record<string, unknown>> | undefined,
    options?: MethodOptions,
  ): Promise<PreparedInvocation<T>>;
  deserialize<T>(json: string): PreparedInvocation<T>;
  decodeResult<T>(method: KernelMethod, value: xdr.ScVal): T;
}
