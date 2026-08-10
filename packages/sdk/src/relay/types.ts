import type { Transaction, xdr } from "@stellar/stellar-sdk";

import type {
  AuthorizationSigner,
  FacilitatorSigner,
  KernelAdapter,
  KernelMethod,
  PreparedInvocation,
} from "../kernel-types.js";

export interface RelayAuthorizationRequirement {
  readonly address: string;
  readonly credentialType: "address" | "addressV2" | "addressWithDelegates";
  readonly nonce: string;
  readonly invocationXdr: string;
}

/**
 * Trusted policy for a relay request.
 *
 * Do not accept an intent supplied only by the same untrusted party that
 * supplies the request. Derive it locally or transport it over an authenticated
 * channel.
 */
export interface RelayIntent {
  readonly version: 1;
  readonly networkPassphrase: string;
  readonly contractId: string;
  readonly method: KernelMethod;
  readonly argumentXdr: readonly string[];
  readonly facilitator: string;
  readonly sequence: string;
  readonly minTime: string;
  readonly maxTime: string;
  readonly maxFee: string;
  readonly transactionTimeoutSeconds: number;
  readonly minSubmissionLifetimeSeconds: number;
  readonly authExpirationLedger: number;
  readonly authSubmitLedgerMargin: number;
  readonly footprint: RelayFootprintPolicy;
  readonly authorizations: readonly RelayAuthorizationRequirement[];
}

/**
 * Canonical state boundary recorded by the first simulation.
 *
 * Protocol-23 archived entries are represented by the exact read-write keys
 * selected by SorobanTransactionData's archived-entry indices.
 */
export interface RelayFootprintPolicy {
  readonly readOnlyLedgerKeyXdr: readonly string[];
  readonly readWriteLedgerKeyXdr: readonly string[];
  readonly archivedReadWriteLedgerKeyXdr: readonly string[];
}

/** Mutable payload passed sequentially between authorization signers. */
export interface RelayRequest {
  readonly version: 1;
  readonly assembledTransaction: string;
}

export interface PrepareRelayOptions {
  /** Hard ceiling for total transaction fee, in stroops. */
  readonly maxFee: string;
  /** Authorization lifetime measured from the recording simulation ledger. */
  readonly authValidForLedgers?: number;
  /** Maximum acceptable remaining transaction lifetime. */
  readonly maxTransactionLifetimeSeconds?: number;
  /** Minimum lifetime remaining whenever the request may be signed/submitted. */
  readonly minSubmissionLifetimeSeconds?: number;
  /** Future-ledger safety margin retained before auth expiration. */
  readonly authSubmitLedgerMargin?: number;
  /** Override for deterministic tests; normally read from simulation. */
  readonly currentLedger?: number;
  /** Override for deterministic tests; defaults to the current wall clock. */
  readonly currentTime?: number;
}

export interface PreparedRelay {
  readonly request: RelayRequest;
  readonly intent: RelayIntent;
}

export interface AuthorizeRelayOptions {
  readonly adapter: KernelAdapter;
  readonly rpc: RelayRpc;
  readonly request: RelayRequest;
  readonly intent: RelayIntent;
  readonly signer: AuthorizationSigner;
  /** Override for deterministic tests. */
  readonly currentTime?: number;
}

export interface FacilitateRelayOptions<T> {
  readonly adapter: KernelAdapter;
  readonly rpc: RelayRpc;
  readonly request: RelayRequest;
  readonly intent: RelayIntent;
  readonly facilitator: FacilitatorSigner;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly currentTime?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly prepared?: PreparedInvocation<unknown>;
}

export interface EnforcedSimulation {
  readonly transaction: Transaction;
  readonly latestLedger: number;
  readonly minResourceFee: string;
}

export interface RelayResourceUsage {
  readonly instructions: number;
  readonly readBytes: number;
  readonly writeBytes: number;
  readonly readOnlyEntries: number;
  readonly readWriteEntries: number;
  readonly declaredResourceFee: string;
  readonly inclusionFee: string;
  readonly totalFee: string;
}

export type RelayEventValue =
  | boolean
  | null
  | number
  | string
  | readonly RelayEventValue[]
  | { readonly [key: string]: RelayEventValue };

export interface DecodedRelayEvent {
  readonly contractId: string;
  readonly name: string;
  readonly decoded: Readonly<Record<string, RelayEventValue>>;
}

export interface RelaySubmission {
  readonly hash: string;
  readonly status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  readonly errorResultXdr?: string;
}

export interface RelayTransactionResult {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly hash: string;
  readonly latestLedger: number;
  readonly ledger?: number;
  readonly createdAt?: number;
  readonly resultXdr?: string;
  readonly returnValue?: xdr.ScVal;
  readonly contractEventsXdr?: readonly string[];
  readonly diagnosticEventsXdr?: readonly string[];
}

export interface RelayRpc {
  getLatestLedger(): Promise<number>;
  /**
   * Rebuild the exact invoke operation/auth tree with the source account's
   * freshly fetched sequence and new finite time bounds.
   */
  refresh(
    transaction: Transaction,
    timeoutInSeconds: number,
  ): Promise<Transaction>;
  enforce(transaction: Transaction): Promise<EnforcedSimulation>;
  submit(transaction: Transaction): Promise<RelaySubmission>;
  getTransaction(hash: string): Promise<RelayTransactionResult>;
}

export interface RelayReceipt<T> {
  readonly method: KernelMethod;
  readonly hash: string;
  readonly status: "SUCCESS";
  readonly ledger: number;
  readonly createdAt: number;
  readonly closedAt: string;
  readonly latestLedger: number;
  readonly fee: string;
  readonly minResourceFee: string;
  readonly resources: RelayResourceUsage;
  readonly source: string;
  readonly contractId: string;
  readonly authorizers: readonly string[];
  readonly argumentsSha256: string;
  readonly envelopeSha256: string;
  readonly returnValueXdr?: string;
  readonly resultXdr?: string;
  readonly contractEventsXdr: readonly string[];
  readonly decodedEvents: readonly DecodedRelayEvent[];
  readonly diagnosticEventsXdr: readonly string[];
  readonly result: T | undefined;
}
