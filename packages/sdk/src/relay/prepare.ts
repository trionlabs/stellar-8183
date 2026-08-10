import { Transaction } from "@stellar/stellar-sdk";

import { invariant } from "../errors.js";
import type { PreparedInvocation } from "../kernel-types.js";
import type {
  PrepareRelayOptions,
  PreparedRelay,
  RelayIntent,
} from "./types.js";
import {
  captureAuthorizations,
  inspectInvocation,
  inspectSorobanFootprint,
  validateRelayTransaction,
} from "./validation.js";

const UINT_PATTERN = /^(0|[1-9]\d*)$/;
const UINT32_MAX = 0xffff_ffff;

function assembledTransaction<T>(prepared: PreparedInvocation<T>): Transaction {
  const built = prepared.transaction.built;
  invariant(
    built instanceof Transaction,
    "UNSUPPORTED_TRANSACTION",
    "prepared invocation has not been simulated into a regular transaction",
  );
  return built;
}

/**
 * Freeze a simulated invocation into a relay request and trusted policy.
 *
 * Keep `intent` in trusted local state. The serialized request may be passed
 * between parties, but replacing both request and intent would defeat
 * validation.
 */
export function prepareRelay<T>(
  prepared: PreparedInvocation<T>,
  options: PrepareRelayOptions,
): PreparedRelay {
  invariant(
    UINT_PATTERN.test(options.maxFee) && BigInt(options.maxFee) > 0n,
    "INVALID_RELAY_INTENT",
    "maxFee must be a positive integer number of stroops",
    { maxFee: options.maxFee },
  );
  const authValidForLedgers = options.authValidForLedgers ?? 100;
  const authSubmitLedgerMargin = options.authSubmitLedgerMargin ?? 3;
  invariant(
    Number.isSafeInteger(authValidForLedgers) &&
      authValidForLedgers >= 1 &&
      authValidForLedgers <= 10_000,
    "INVALID_RELAY_INTENT",
    "authValidForLedgers must be between 1 and 10,000",
  );
  invariant(
    Number.isSafeInteger(authSubmitLedgerMargin) &&
      authSubmitLedgerMargin >= 1 &&
      authSubmitLedgerMargin <= 100 &&
      authValidForLedgers > authSubmitLedgerMargin,
    "INVALID_RELAY_INTENT",
    "authSubmitLedgerMargin must be between 1 and 100 and below authValidForLedgers",
  );
  const currentTime = options.currentTime ?? Math.floor(Date.now() / 1000);
  invariant(
    Number.isSafeInteger(currentTime) && currentTime >= 0,
    "INVALID_ARGUMENT",
    "currentTime must be a non-negative Unix timestamp",
  );

  const transaction = assembledTransaction(prepared);
  const invocation = inspectInvocation(transaction);
  invariant(
    invocation.method === prepared.method,
    "INVALID_RELAY_INTENT",
    "prepared method metadata does not match transaction XDR",
  );
  const simulationLedger =
    options.currentLedger ?? prepared.transaction.simulation?.latestLedger;
  invariant(
    simulationLedger !== undefined &&
      Number.isSafeInteger(simulationLedger) &&
      simulationLedger >= 0,
    "INVALID_RELAY_INTENT",
    "recording simulation ledger is unavailable",
  );
  const authExpirationLedger = simulationLedger + authValidForLedgers;
  invariant(
    authExpirationLedger <= UINT32_MAX,
    "INVALID_RELAY_INTENT",
    "authorization expiration exceeds uint32",
  );
  const bounds = transaction.timeBounds;
  invariant(
    bounds !== undefined && bounds.maxTime !== "0",
    "INVALID_RELAY_INTENT",
    "prepared transaction must have finite time bounds",
  );
  const maxTransactionLifetimeSeconds =
    options.maxTransactionLifetimeSeconds ?? 300;
  const minSubmissionLifetimeSeconds =
    options.minSubmissionLifetimeSeconds ?? 15;
  invariant(
    Number.isSafeInteger(maxTransactionLifetimeSeconds) &&
      maxTransactionLifetimeSeconds >= 1 &&
      maxTransactionLifetimeSeconds <= 3600,
    "INVALID_RELAY_INTENT",
    "maxTransactionLifetimeSeconds must be between 1 and 3,600",
  );
  invariant(
    Number.isSafeInteger(minSubmissionLifetimeSeconds) &&
      minSubmissionLifetimeSeconds >= 1 &&
      minSubmissionLifetimeSeconds <= 300 &&
      minSubmissionLifetimeSeconds < maxTransactionLifetimeSeconds,
    "INVALID_RELAY_INTENT",
    "minSubmissionLifetimeSeconds must be between 1 and 300 and below the maximum lifetime",
  );
  invariant(
    BigInt(bounds.maxTime) - BigInt(currentTime) <=
      BigInt(maxTransactionLifetimeSeconds),
    "INVALID_RELAY_INTENT",
    "prepared transaction remains valid longer than allowed",
    {
      maxTime: bounds.maxTime,
      currentTime,
      maxTransactionLifetimeSeconds,
    },
  );
  const footprint = inspectSorobanFootprint(transaction);

  const intent: RelayIntent = Object.freeze({
    version: 1,
    networkPassphrase: transaction.networkPassphrase,
    contractId: invocation.contractId,
    method: prepared.method,
    argumentXdr: Object.freeze([...invocation.argumentXdr]),
    facilitator: transaction.source,
    sequence: transaction.sequence,
    minTime: bounds.minTime,
    maxTime: bounds.maxTime,
    maxFee: options.maxFee,
    transactionTimeoutSeconds: maxTransactionLifetimeSeconds,
    minSubmissionLifetimeSeconds,
    authExpirationLedger,
    authSubmitLedgerMargin,
    footprint: Object.freeze({
      readOnlyLedgerKeyXdr: Object.freeze([...footprint.readOnlyLedgerKeyXdr]),
      readWriteLedgerKeyXdr: Object.freeze([
        ...footprint.readWriteLedgerKeyXdr,
      ]),
      archivedReadWriteLedgerKeyXdr: Object.freeze([
        ...footprint.archivedReadWriteLedgerKeyXdr,
      ]),
    }),
    authorizations: Object.freeze(
      captureAuthorizations(
        invocation.auth,
        transaction.source,
        invocation,
      ).map((requirement) => Object.freeze({ ...requirement })),
    ),
  });

  validateRelayTransaction(transaction, intent, {
    currentLedger: simulationLedger,
    currentTime,
    requireAllAuthorizations: false,
  });

  return {
    request: {
      version: 1,
      assembledTransaction: prepared.transaction.toJSON(),
    },
    intent,
  };
}
