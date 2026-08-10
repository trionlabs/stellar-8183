import {
  Address,
  Transaction,
  checkAuthEntryReadiness,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";
import type { Operation } from "@stellar/stellar-sdk";

import { invariant } from "../errors.js";
import type { KernelMethod } from "../kernel-types.js";
import type {
  RelayAuthorizationRequirement,
  RelayFootprintPolicy,
  RelayIntent,
} from "./types.js";

const UINT_PATTERN = /^(0|[1-9]\d*)$/;

export interface InspectedInvocation {
  readonly contractId: string;
  readonly method: string;
  readonly argumentXdr: readonly string[];
  /** Exact InvokeContractArgs XDR used to bind every authorization root. */
  readonly invocationXdr: string;
  readonly auth: readonly xdr.SorobanAuthorizationEntry[];
}

export interface RelayValidationOptions {
  readonly currentLedger: number;
  readonly currentTime: number;
  readonly requireAllAuthorizations: boolean;
  readonly allowEnvelopeSignatures?: boolean;
  /** Refresh transactions intentionally omit data until enforcing simulation. */
  readonly requireSorobanData?: boolean;
}

function parseUnsigned(value: string, label: string): bigint {
  invariant(
    UINT_PATTERN.test(value),
    "INVALID_RELAY_INTENT",
    `${label} must be an unsigned decimal integer`,
    { [label]: value },
  );
  return BigInt(value);
}

function invokeOperation(
  transaction: Transaction,
): Operation.InvokeHostFunction {
  invariant(
    transaction.operations.length === 1,
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction must contain exactly one operation",
    { operationCount: transaction.operations.length },
  );
  const operation = transaction.operations[0]!;
  invariant(
    operation.type === "invokeHostFunction",
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction must contain one invokeHostFunction operation",
    { operationType: operation.type },
  );
  invariant(
    operation.source === undefined,
    "RELAY_ENVELOPE_MISMATCH",
    "relay invocation must not override the transaction source",
  );
  return operation;
}

export function inspectInvocation(
  transaction: Transaction,
): InspectedInvocation {
  const operation = invokeOperation(transaction);
  invariant(
    operation.func.switch().value ===
      xdr.HostFunctionType.hostFunctionTypeInvokeContract().value,
    "RELAY_ENVELOPE_MISMATCH",
    "host function must invoke an existing contract",
  );
  const invocation = operation.func.invokeContract();
  return {
    contractId: Address.fromScAddress(invocation.contractAddress()).toString(),
    method: invocation.functionName().toString(),
    argumentXdr: invocation.args().map((argument) => argument.toXDR("base64")),
    invocationXdr: invocation.toXDR("base64"),
    auth: operation.auth ?? [],
  };
}

function sortedLedgerKeyXdr(keys: readonly xdr.LedgerKey[]): readonly string[] {
  return keys.map((key) => key.toXDR("base64")).toSorted();
}

export function inspectSorobanFootprint(
  transaction: Transaction,
): RelayFootprintPolicy {
  const envelope = transaction.toEnvelope();
  invariant(
    envelope.switch().value === xdr.EnvelopeType.envelopeTypeTx().value,
    "UNSUPPORTED_TRANSACTION",
    "relay invocation must use a v1 transaction envelope",
  );
  const extension = envelope.v1().tx().ext();
  invariant(
    extension.switch() === 1,
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction omitted Soroban resource data",
  );
  const data = extension.sorobanData();
  const footprint = data.resources().footprint();
  const readOnly = footprint.readOnly();
  const readWrite = footprint.readWrite();
  const allKeys = [...readOnly, ...readWrite].map((key) => key.toXDR("base64"));
  invariant(
    new Set(allKeys).size === allKeys.length,
    "RELAY_ENVELOPE_MISMATCH",
    "relay footprint contains a duplicate ledger key",
  );

  const dataExtension = data.ext();
  invariant(
    dataExtension.switch() === 0 || dataExtension.switch() === 1,
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction uses an unsupported Soroban data extension",
  );
  const archivedIndices =
    dataExtension.switch() === 1
      ? dataExtension.resourceExt().archivedSorobanEntries()
      : [];
  let priorIndex = -1;
  const archivedKeys = archivedIndices.map((index) => {
    invariant(
      Number.isSafeInteger(index) &&
        index > priorIndex &&
        index < readWrite.length,
      "RELAY_ENVELOPE_MISMATCH",
      "archived-entry indices must be strictly increasing and within the read-write footprint",
      { index, priorIndex, readWriteCount: readWrite.length },
    );
    priorIndex = index;
    return readWrite[index]!.toXDR("base64");
  });

  return {
    readOnlyLedgerKeyXdr: sortedLedgerKeyXdr(readOnly),
    readWriteLedgerKeyXdr: sortedLedgerKeyXdr(readWrite),
    archivedReadWriteLedgerKeyXdr: archivedKeys.toSorted(),
  };
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateSorobanFootprint(
  transaction: Transaction,
  expected: RelayFootprintPolicy,
): void {
  const actual = inspectSorobanFootprint(transaction);
  invariant(
    sameStrings(actual.readOnlyLedgerKeyXdr, expected.readOnlyLedgerKeyXdr) &&
      sameStrings(
        actual.readWriteLedgerKeyXdr,
        expected.readWriteLedgerKeyXdr,
      ) &&
      sameStrings(
        actual.archivedReadWriteLedgerKeyXdr,
        expected.archivedReadWriteLedgerKeyXdr,
      ),
    "RELAY_ENVELOPE_MISMATCH",
    "Soroban footprint or archived-entry restore list changed after preparation",
    {
      actualReadOnly: actual.readOnlyLedgerKeyXdr.length,
      expectedReadOnly: expected.readOnlyLedgerKeyXdr.length,
      actualReadWrite: actual.readWriteLedgerKeyXdr.length,
      expectedReadWrite: expected.readWriteLedgerKeyXdr.length,
      actualArchived: actual.archivedReadWriteLedgerKeyXdr.length,
      expectedArchived: expected.archivedReadWriteLedgerKeyXdr.length,
    },
  );
}

function assertStrictAuthorizationRoots(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  invocation: InspectedInvocation,
): void {
  entries.forEach((entry, index) => {
    const root = inspectAuthEntry(entry).invocation.function();
    invariant(
      root.switch().value ===
        xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
          .value &&
        root.contractFn().toXDR("base64") === invocation.invocationXdr,
      "RELAY_AUTHORIZATION_MISMATCH",
      "authorization root must exactly match the outer contract invocation",
      { index },
    );
  });
}

export function captureAuthorizations(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  facilitator: string,
  invocation: InspectedInvocation,
): RelayAuthorizationRequirement[] {
  assertStrictAuthorizationRoots(entries, invocation);
  const seenRequirements = new Set<string>();
  return entries.map((entry, index) => {
    const info = inspectAuthEntry(entry);
    invariant(
      info.credentialType !== "sourceAccount" &&
        info.address !== null &&
        info.nonce !== null,
      "RELAY_AUTHORIZATION_MISMATCH",
      "relay recording produced source-account authorization",
      { index },
    );
    invariant(
      info.address !== facilitator,
      "RELAY_AUTHORIZATION_MISMATCH",
      "facilitator must not also authorize a contract role",
      { address: info.address, index },
    );
    invariant(
      !info.signed,
      "RELAY_AUTHORIZATION_MISMATCH",
      "new relay request must not contain pre-signed authorization entries",
      { address: info.address, index },
    );
    const requirement = {
      address: info.address,
      credentialType: info.credentialType,
      nonce: info.nonce.toString(),
      invocationXdr: info.invocation.toXDR("base64"),
    };
    const identity = JSON.stringify(requirement);
    invariant(
      !seenRequirements.has(identity),
      "RELAY_AUTHORIZATION_MISMATCH",
      "recording simulation produced a duplicate authorization requirement",
      { address: info.address, index },
    );
    seenRequirements.add(identity);
    return requirement;
  });
}

function validateFixedEnvelope(
  transaction: Transaction,
  intent: RelayIntent,
  options: RelayValidationOptions,
): InspectedInvocation {
  invariant(
    transaction.networkPassphrase === intent.networkPassphrase,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction network passphrase does not match relay intent",
  );
  invariant(
    transaction.source === intent.facilitator,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction source is not the expected facilitator",
    {
      actual: transaction.source,
      expected: intent.facilitator,
    },
  );
  invariant(
    transaction.sequence === intent.sequence,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction sequence changed after preparation",
    {
      actual: transaction.sequence,
      expected: intent.sequence,
    },
  );
  invariant(
    options.allowEnvelopeSignatures === true ||
      transaction.signatures.length === 0,
    "RELAY_ENVELOPE_MISMATCH",
    "relay request must not contain transaction-envelope signatures",
    { signatureCount: transaction.signatures.length },
  );
  invariant(
    transaction.memo.type === "none",
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction must not contain a memo",
  );
  invariant(
    transaction.ledgerBounds === undefined &&
      transaction.minAccountSequence === undefined &&
      transaction.minAccountSequenceAge === undefined &&
      transaction.minAccountSequenceLedgerGap === undefined &&
      transaction.extraSigners === undefined,
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction contains unsupported preconditions",
  );

  const bounds = transaction.timeBounds;
  invariant(
    bounds !== undefined,
    "RELAY_ENVELOPE_MISMATCH",
    "relay transaction must have finite time bounds",
  );
  invariant(
    bounds.minTime === intent.minTime && bounds.maxTime === intent.maxTime,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction time bounds changed after preparation",
    {
      actual: bounds,
      expected: { minTime: intent.minTime, maxTime: intent.maxTime },
    },
  );
  const minTime = parseUnsigned(bounds.minTime, "minTime");
  const maxTime = parseUnsigned(bounds.maxTime, "maxTime");
  invariant(
    maxTime !== 0n && maxTime > BigInt(options.currentTime),
    "RELAY_EXPIRED",
    "relay transaction has expired",
    { maxTime: bounds.maxTime, currentTime: options.currentTime },
  );
  invariant(
    minTime <= BigInt(options.currentTime),
    "RELAY_EXPIRED",
    "relay transaction is not yet valid",
    { minTime: bounds.minTime, currentTime: options.currentTime },
  );
  invariant(
    maxTime - BigInt(options.currentTime) >=
      BigInt(intent.minSubmissionLifetimeSeconds),
    "RELAY_EXPIRED",
    "relay transaction is too close to its time-bound expiry",
    {
      maxTime: bounds.maxTime,
      currentTime: options.currentTime,
      requiredMargin: intent.minSubmissionLifetimeSeconds,
    },
  );

  const fee = parseUnsigned(transaction.fee, "fee");
  const maxFee = parseUnsigned(intent.maxFee, "maxFee");
  invariant(
    fee <= maxFee,
    "RELAY_FEE_EXCEEDED",
    "transaction fee exceeds the relay ceiling",
    { fee: transaction.fee, maxFee: intent.maxFee },
  );

  const invocation = inspectInvocation(transaction);
  invariant(
    invocation.contractId === intent.contractId,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction targets the wrong contract",
    {
      actual: invocation.contractId,
      expected: intent.contractId,
    },
  );
  invariant(
    invocation.method === intent.method,
    "RELAY_ENVELOPE_MISMATCH",
    "transaction invokes the wrong contract method",
    { actual: invocation.method, expected: intent.method },
  );
  invariant(
    invocation.argumentXdr.length === intent.argumentXdr.length &&
      invocation.argumentXdr.every(
        (argument, index) => argument === intent.argumentXdr[index],
      ),
    "RELAY_ENVELOPE_MISMATCH",
    "contract arguments changed after preparation",
  );
  return invocation;
}

function validateAuthorizations(
  entries: readonly xdr.SorobanAuthorizationEntry[],
  intent: RelayIntent,
  options: RelayValidationOptions,
): void {
  invariant(
    entries.length === intent.authorizations.length,
    "RELAY_AUTHORIZATION_MISMATCH",
    "authorization entry count changed after preparation",
    {
      actual: entries.length,
      expected: intent.authorizations.length,
    },
  );

  entries.forEach((entry, index) => {
    const expected = intent.authorizations[index]!;
    const actual = inspectAuthEntry(entry);
    invariant(
      actual.credentialType === expected.credentialType &&
        actual.address === expected.address &&
        actual.nonce?.toString() === expected.nonce &&
        actual.invocation.toXDR("base64") === expected.invocationXdr,
      "RELAY_AUTHORIZATION_MISMATCH",
      "authorization identity, nonce, or invocation tree changed",
      {
        index,
        expectedAddress: expected.address,
        actualAddress: actual.address,
      },
    );
    invariant(
      actual.address !== intent.facilitator,
      "RELAY_AUTHORIZATION_MISMATCH",
      "facilitator must not appear in contract authorization entries",
      { index },
    );

    if (actual.signed || options.requireAllAuthorizations) {
      invariant(
        actual.signed,
        "RELAY_AUTHORIZATION_MISMATCH",
        "required authorization entry is unsigned",
        { address: expected.address, index },
      );
      invariant(
        actual.signatureExpirationLedger === intent.authExpirationLedger,
        "RELAY_AUTHORIZATION_MISMATCH",
        "authorization expiration does not match relay intent",
        {
          actual: actual.signatureExpirationLedger,
          expected: intent.authExpirationLedger,
          index,
        },
      );
      const readiness = checkAuthEntryReadiness(entry, options.currentLedger);
      invariant(
        readiness.ready,
        "RELAY_EXPIRED",
        "authorization is unsigned or expired",
        {
          address: expected.address,
          expired: readiness.expired,
          unsignedBy: readiness.unsignedBy,
        },
      );
      invariant(
        actual.signatureExpirationLedger !== null &&
          actual.signatureExpirationLedger - options.currentLedger >
            intent.authSubmitLedgerMargin,
        "RELAY_EXPIRED",
        "authorization is too close to its ledger expiration",
        {
          currentLedger: options.currentLedger,
          expirationLedger: actual.signatureExpirationLedger,
          requiredMargin: intent.authSubmitLedgerMargin,
        },
      );
    } else {
      invariant(
        actual.signatureExpirationLedger === 0 ||
          actual.signatureExpirationLedger === intent.authExpirationLedger,
        "RELAY_AUTHORIZATION_MISMATCH",
        "unsigned authorization has an unexpected expiration ledger",
        { index, expiration: actual.signatureExpirationLedger },
      );
    }
  });
}

export function validateRelayTransaction(
  transaction: Transaction,
  intent: RelayIntent,
  options: RelayValidationOptions,
): InspectedInvocation {
  invariant(
    intent.version === 1,
    "INVALID_RELAY_INTENT",
    "unsupported relay intent version",
    { version: intent.version },
  );
  invariant(
    Number.isSafeInteger(intent.minSubmissionLifetimeSeconds) &&
      intent.minSubmissionLifetimeSeconds >= 1 &&
      Number.isSafeInteger(intent.authSubmitLedgerMargin) &&
      intent.authSubmitLedgerMargin >= 1,
    "INVALID_RELAY_INTENT",
    "relay intent contains invalid submission safety margins",
  );
  invariant(
    Number.isSafeInteger(options.currentLedger) && options.currentLedger >= 0,
    "INVALID_ARGUMENT",
    "current ledger must be a non-negative safe integer",
  );
  invariant(
    Number.isSafeInteger(options.currentTime) && options.currentTime >= 0,
    "INVALID_ARGUMENT",
    "current time must be a non-negative Unix timestamp",
  );
  const invocation = validateFixedEnvelope(transaction, intent, options);
  if (options.requireSorobanData !== false) {
    validateSorobanFootprint(transaction, intent.footprint);
  }
  assertStrictAuthorizationRoots(invocation.auth, invocation);
  validateAuthorizations(invocation.auth, intent, options);
  return invocation;
}

export function requireKernelMethod(method: string): KernelMethod {
  return method as KernelMethod;
}
