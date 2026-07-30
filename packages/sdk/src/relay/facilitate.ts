import {
  Address,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  hash,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

import { AgenticCommerceError, invariant } from "../errors.js";
import {
  type ContractResult,
  methodReturnsContractResult,
  unwrapContractResult,
} from "../contract-result.js";
import type {
  FacilitateRelayOptions,
  DecodedRelayEvent,
  RelayEventValue,
  RelayReceipt,
  RelayResourceUsage,
  RelayTransactionResult,
} from "./types.js";
import { validateRelayTransaction } from "./validation.js";

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function transactionOrThrow(value: unknown): Transaction {
  invariant(
    value instanceof Transaction,
    "UNSUPPORTED_TRANSACTION",
    "relay request did not deserialize to a regular transaction",
  );
  return value;
}

async function waitForResult(
  hash: string,
  options: FacilitateRelayOptions<unknown>,
): Promise<RelayTransactionResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  invariant(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    "INVALID_ARGUMENT",
    "timeoutMs must be a positive integer",
  );
  invariant(
    Number.isSafeInteger(pollIntervalMs) &&
      pollIntervalMs > 0 &&
      pollIntervalMs <= timeoutMs,
    "INVALID_ARGUMENT",
    "pollIntervalMs must be positive and cannot exceed timeoutMs",
  );
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await options.rpc.getTransaction(hash);
    if (result.status !== "NOT_FOUND") {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new AgenticCommerceError(
        "RELAY_TIMEOUT",
        "transaction was not finalized before the relay timeout",
        { hash, timeoutMs },
      );
    }
    await sleep(pollIntervalMs);
  }
}

function verifyFacilitatorSignature(
  transaction: Transaction,
  facilitator: string,
): void {
  invariant(
    StrKey.isValidEd25519PublicKey(facilitator),
    "SIGNER_MISMATCH",
    "facilitator must be a G-address",
    { facilitator },
  );
  invariant(
    transaction.signatures.length === 1,
    "SIGNER_MISMATCH",
    "facilitator must add exactly one envelope signature",
    { signatureCount: transaction.signatures.length },
  );
  const signature = transaction.signatures[0]!.signature();
  invariant(
    Keypair.fromPublicKey(facilitator).verify(transaction.hash(), signature),
    "SIGNER_MISMATCH",
    "transaction envelope is not signed by the facilitator",
  );
}

export function extractResourceUsage(
  transaction: Transaction,
): RelayResourceUsage {
  const envelope = transaction.toEnvelope();
  invariant(
    envelope.switch().value === xdr.EnvelopeType.envelopeTypeTx().value,
    "UNSUPPORTED_TRANSACTION",
    "Soroban invocation must use a v1 transaction envelope",
  );
  const extension = envelope.v1().tx().ext();
  invariant(
    extension.switch() === 1,
    "RELAY_SIMULATION_FAILED",
    "enforced transaction omitted Soroban resource data",
  );
  const data = extension.sorobanData();
  const resources = data.resources();
  const resourceFee = BigInt(data.resourceFee().toString());
  const totalFee = BigInt(transaction.fee);
  invariant(
    resourceFee >= 0n && totalFee >= resourceFee,
    "RELAY_SIMULATION_FAILED",
    "enforced transaction contains inconsistent fee data",
    {
      resourceFee: resourceFee.toString(),
      totalFee: totalFee.toString(),
    },
  );
  return {
    instructions: resources.instructions(),
    readBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    readOnlyEntries: resources.footprint().readOnly().length,
    readWriteEntries: resources.footprint().readWrite().length,
    declaredResourceFee: resourceFee.toString(),
    inclusionFee: (totalFee - resourceFee).toString(),
    totalFee: totalFee.toString(),
  };
}

function toEventValue(value: unknown): RelayEventValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toEventValue(entry));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [
        String(key),
        toEventValue(entry),
      ]),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toEventValue(entry)]),
    );
  }
  return String(value);
}

export function decodeContractEvent(eventXdr: string): DecodedRelayEvent {
  const event = xdr.ContractEvent.fromXDR(eventXdr, "base64");
  const rawContractId = event.contractId();
  invariant(
    rawContractId !== null,
    "RELAY_SUBMISSION_FAILED",
    "contract event omitted its contract ID",
  );
  const body = event.body().v0();
  const topics = body.topics().map((topic) => scValToNative(topic) as unknown);
  const firstTopic = topics[0];
  return {
    contractId: Address.contract(
      Buffer.from(rawContractId as unknown as Uint8Array),
    ).toString(),
    name: typeof firstTopic === "string" ? firstTopic : "contract_event",
    decoded: {
      topics: topics.slice(1).map((topic) => toEventValue(topic)),
      data: toEventValue(scValToNative(body.data())),
    },
  };
}

export function hashRelayArguments(argumentXdr: readonly string[]): string {
  const encoded = argumentXdr.map((argument) =>
    Buffer.from(argument, "base64"),
  );
  const framed: Buffer[] = [];
  for (const argument of encoded) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(argument.length);
    framed.push(length, argument);
  }
  return hash(Buffer.concat(framed)).toString("hex");
}

/**
 * Re-simulate signed auth in enforcing mode, validate the final envelope,
 * collect the facilitator signature, submit, and wait for finality.
 */
export async function facilitateRelay<T>(
  options: FacilitateRelayOptions<T>,
): Promise<RelayReceipt<T>> {
  invariant(
    options.request.version === 1,
    "INVALID_RELAY_INTENT",
    "unsupported relay request version",
  );
  invariant(
    options.facilitator.address === options.intent.facilitator,
    "SIGNER_MISMATCH",
    "facilitator signer does not match relay intent",
    {
      actual: options.facilitator.address,
      expected: options.intent.facilitator,
    },
  );

  const prepared = options.adapter.deserialize<T>(
    options.request.assembledTransaction,
  );
  invariant(
    prepared.method === options.intent.method,
    "RELAY_ENVELOPE_MISMATCH",
    "serialized method does not match relay intent",
  );
  const recorded = transactionOrThrow(prepared.transaction.built);
  const currentLedger = await options.rpc.getLatestLedger();
  const readCurrentTime = (): number =>
    options.currentTime ?? Math.floor(Date.now() / 1000);
  const recordedTime = readCurrentTime();
  validateRelayTransaction(recorded, options.intent, {
    currentLedger,
    currentTime: recordedTime,
    requireAllAuthorizations: true,
  });

  const refreshed = await options.rpc.refresh(
    recorded,
    options.intent.transactionTimeoutSeconds,
  );
  const refreshedTime = readCurrentTime();
  const refreshedBounds = refreshed.timeBounds;
  invariant(
    refreshedBounds !== undefined &&
      refreshedBounds.maxTime !== "0" &&
      BigInt(refreshedBounds.maxTime) - BigInt(refreshedTime) <=
        BigInt(options.intent.transactionTimeoutSeconds),
    "RELAY_ENVELOPE_MISMATCH",
    "refreshed transaction has invalid facilitator time bounds",
  );
  const finalIntent = {
    ...options.intent,
    sequence: refreshed.sequence,
    minTime: refreshedBounds.minTime,
    maxTime: refreshedBounds.maxTime,
  };
  validateRelayTransaction(refreshed, finalIntent, {
    currentLedger,
    currentTime: refreshedTime,
    requireAllAuthorizations: true,
    requireSorobanData: false,
  });

  const enforced = await options.rpc.enforce(refreshed);
  invariant(
    enforced.latestLedger >= currentLedger,
    "RELAY_SIMULATION_FAILED",
    "enforcing simulation reported an older ledger",
    { before: currentLedger, after: enforced.latestLedger },
  );
  const enforcedTime = readCurrentTime();
  validateRelayTransaction(enforced.transaction, finalIntent, {
    currentLedger: enforced.latestLedger,
    currentTime: enforcedTime,
    requireAllAuthorizations: true,
  });
  const resources = extractResourceUsage(enforced.transaction);

  const signingResponse = await options.facilitator.signTransaction(
    enforced.transaction.toXDR(),
    {
      address: options.facilitator.address,
      networkPassphrase: options.intent.networkPassphrase,
      submit: false,
    },
  );
  invariant(
    signingResponse.error === undefined,
    "SIGNER_MISMATCH",
    "facilitator wallet returned an error",
    { error: signingResponse.error },
  );
  invariant(
    signingResponse.signerAddress === undefined ||
      signingResponse.signerAddress === options.facilitator.address,
    "SIGNER_MISMATCH",
    "wallet signed with a different facilitator address",
    {
      actual: signingResponse.signerAddress,
      expected: options.facilitator.address,
    },
  );
  const signed = TransactionBuilder.fromXDR(
    signingResponse.signedTxXdr,
    options.intent.networkPassphrase,
  );
  invariant(
    signed instanceof Transaction,
    "UNSUPPORTED_TRANSACTION",
    "facilitator returned a fee-bump transaction",
  );
  invariant(
    signed.signatureBase().equals(enforced.transaction.signatureBase()),
    "RELAY_ENVELOPE_MISMATCH",
    "facilitator wallet changed the transaction body while signing",
  );
  verifyFacilitatorSignature(signed, options.facilitator.address);
  const submissionLedger = await options.rpc.getLatestLedger();
  invariant(
    submissionLedger >= enforced.latestLedger,
    "RELAY_SIMULATION_FAILED",
    "RPC latest-ledger sequence moved backwards before submission",
    { before: enforced.latestLedger, after: submissionLedger },
  );
  validateRelayTransaction(signed, finalIntent, {
    currentLedger: submissionLedger,
    currentTime: readCurrentTime(),
    requireAllAuthorizations: true,
    allowEnvelopeSignatures: true,
  });
  const envelopeSha256 = hash(Buffer.from(signed.toXDR(), "base64")).toString(
    "hex",
  );

  const localHash = signed.hash().toString("hex");
  const submission = await options.rpc.submit(signed);
  invariant(
    submission.status === "PENDING" || submission.status === "DUPLICATE",
    "RELAY_SUBMISSION_FAILED",
    "RPC rejected the facilitated transaction",
    {
      hash: submission.hash,
      status: submission.status,
      errorResultXdr: submission.errorResultXdr,
    },
  );
  invariant(
    submission.hash === localHash,
    "RELAY_SUBMISSION_FAILED",
    "RPC submission hash does not match the locally signed transaction",
    { actual: submission.hash, expected: localHash },
  );
  const final = await waitForResult(
    localHash,
    options as FacilitateRelayOptions<unknown>,
  );
  if (final.status !== "SUCCESS") {
    throw new AgenticCommerceError(
      "RELAY_SUBMISSION_FAILED",
      "facilitated transaction failed on-chain",
      {
        hash: final.hash,
        ledger: final.ledger,
        resultXdr: final.resultXdr,
      },
    );
  }
  invariant(
    final.ledger !== undefined && final.createdAt !== undefined,
    "RELAY_SUBMISSION_FAILED",
    "successful RPC response omitted ledger metadata",
    { hash: final.hash },
  );
  invariant(
    final.hash === localHash,
    "RELAY_SUBMISSION_FAILED",
    "RPC finalized a different transaction hash",
    { actual: final.hash, expected: localHash },
  );

  const decodedNative =
    final.returnValue === undefined
      ? undefined
      : options.adapter.decodeResult<unknown>(
          options.intent.method,
          final.returnValue,
        );
  const decoded =
    decodedNative === undefined
      ? undefined
      : methodReturnsContractResult(options.intent.method)
        ? unwrapContractResult(
            decodedNative as ContractResult<T>,
            options.intent.method,
          )
        : (decodedNative as T);
  const decodedEvents = (final.contractEventsXdr ?? []).map((event) =>
    decodeContractEvent(event),
  );
  return {
    method: options.intent.method,
    hash: final.hash,
    status: "SUCCESS",
    ledger: final.ledger,
    createdAt: final.createdAt,
    closedAt: new Date(final.createdAt * 1000).toISOString(),
    latestLedger: final.latestLedger,
    fee: signed.fee,
    minResourceFee: enforced.minResourceFee,
    resources,
    source: signed.source,
    contractId: options.intent.contractId,
    authorizers: [
      ...new Set(options.intent.authorizations.map(({ address }) => address)),
    ],
    argumentsSha256: hashRelayArguments(options.intent.argumentXdr),
    envelopeSha256,
    returnValueXdr: final.returnValue?.toXDR("base64"),
    resultXdr: final.resultXdr,
    contractEventsXdr: final.contractEventsXdr ?? [],
    decodedEvents,
    diagnosticEventsXdr: final.diagnosticEventsXdr ?? [],
    result: decoded,
  };
}
