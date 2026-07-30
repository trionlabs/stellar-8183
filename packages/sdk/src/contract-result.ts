import type {
  ErrorMessage,
  Result as StellarResult,
} from "@stellar/stellar-sdk/contract";

import { AgenticCommerceError, invariant } from "./errors.js";
import type { KernelMethod } from "./kernel-types.js";
import type { RelayReceipt } from "./relay/types.js";

export type ContractResult<
  T,
  E extends ErrorMessage = ErrorMessage,
> = StellarResult<T, E>;

const RESULT_METHODS = new Set<KernelMethod>([
  "create_job",
  "set_provider",
  "set_budget",
  "fund",
  "submit",
  "complete",
  "reject",
  "claim_refund",
  "get_job",
  "keep_alive",
  "accept_admin",
]);

export function methodReturnsContractResult(method: KernelMethod): boolean {
  return RESULT_METHODS.has(method);
}

export function isContractResult<T = unknown>(
  value: unknown,
): value is ContractResult<T> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ContractResult<T>>;
  return (
    typeof candidate.isOk === "function" &&
    typeof candidate.isErr === "function" &&
    typeof candidate.unwrap === "function" &&
    typeof candidate.unwrapErr === "function"
  );
}

/** Unwrap a generated Rust Result and preserve a stable SDK error code. */
export function unwrapContractResult<T>(
  result: ContractResult<T>,
  method?: KernelMethod,
): T {
  invariant(
    isContractResult<T>(result),
    "INVALID_ARGUMENT",
    "generated client did not return a Rust Result",
    { method },
  );
  if (result.isOk()) {
    return result.unwrap();
  }
  const contractError = result.unwrapErr();
  throw new AgenticCommerceError("CONTRACT_ERROR", contractError.message, {
    method,
    contractError,
  });
}

/** Convert a relayed generated-client receipt into an ergonomic bare result. */
export function unwrapRelayReceipt<T>(
  receipt: RelayReceipt<ContractResult<T>>,
): RelayReceipt<T> {
  invariant(
    receipt.result !== undefined,
    "RELAY_SUBMISSION_FAILED",
    "successful contract transaction omitted its return value",
    { method: receipt.method, hash: receipt.hash },
  );
  return {
    ...receipt,
    result: unwrapContractResult(receipt.result, receipt.method),
  };
}
