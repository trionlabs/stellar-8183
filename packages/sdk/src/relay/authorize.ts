import { Transaction, inspectAuthEntry } from "@stellar/stellar-sdk";

import { invariant } from "../errors.js";
import type { AuthorizeRelayOptions, RelayRequest } from "./types.js";
import { inspectInvocation, validateRelayTransaction } from "./validation.js";

function transactionOrThrow(value: unknown): Transaction {
  invariant(
    value instanceof Transaction,
    "UNSUPPORTED_TRANSACTION",
    "relay request did not deserialize to a regular transaction",
  );
  return value;
}

/**
 * Sign every still-unsigned auth entry belonging to one address.
 *
 * Requests must be authorized sequentially. The function verifies that no
 * unrelated entry or transaction field changes while the wallet callback runs.
 */
export async function authorizeRelay(
  options: AuthorizeRelayOptions,
): Promise<RelayRequest> {
  invariant(
    options.request.version === 1,
    "INVALID_RELAY_INTENT",
    "unsupported relay request version",
  );
  invariant(
    options.signer.address !== options.intent.facilitator,
    "SIGNER_MISMATCH",
    "facilitator cannot sign a role authorization entry",
  );
  const prepared = options.adapter.deserialize(
    options.request.assembledTransaction,
  );
  invariant(
    prepared.method === options.intent.method,
    "RELAY_ENVELOPE_MISMATCH",
    "serialized method does not match relay intent",
  );
  const before = transactionOrThrow(prepared.transaction.built);
  const readCurrentTime = (): number =>
    options.currentTime ?? Math.floor(Date.now() / 1000);
  const currentLedger = await options.rpc.getLatestLedger();
  const invocationBefore = validateRelayTransaction(before, options.intent, {
    currentLedger,
    currentTime: readCurrentTime(),
    requireAllAuthorizations: false,
  });
  const beforeEntries = invocationBefore.auth.map((entry) =>
    entry.toXDR("base64"),
  );
  const unsignedForSigner = invocationBefore.auth.filter((entry) => {
    const info = inspectAuthEntry(entry);
    return info.address === options.signer.address && !info.signed;
  }).length;
  invariant(
    unsignedForSigner > 0,
    "SIGNER_MISMATCH",
    "relay request has no unsigned authorization for this signer",
    { signer: options.signer.address },
  );

  let callbackCount = 0;
  await prepared.transaction.signAuthEntries({
    address: options.signer.address,
    expiration: options.intent.authExpirationLedger,
    signAuthEntry: async (preimage, signerOptions) => {
      invariant(
        signerOptions?.address === options.signer.address,
        "SIGNER_MISMATCH",
        "wallet was asked to sign for an unexpected address",
        {
          actual: signerOptions?.address,
          expected: options.signer.address,
        },
      );
      const response = await options.signer.signAuthEntry(
        preimage,
        signerOptions,
      );
      invariant(
        response.error === undefined,
        "SIGNER_MISMATCH",
        "authorization signer returned an error",
        { error: response.error },
      );
      invariant(
        response.signerAddress === undefined ||
          response.signerAddress === options.signer.address,
        "SIGNER_MISMATCH",
        "wallet signed with a different address",
        {
          actual: response.signerAddress,
          expected: options.signer.address,
        },
      );
      callbackCount += 1;
      return response;
    },
  });
  invariant(
    callbackCount === unsignedForSigner,
    "SIGNER_MISMATCH",
    "wallet callback count did not match signer authorization count",
    { actual: callbackCount, expected: unsignedForSigner },
  );

  const after = transactionOrThrow(prepared.transaction.built);
  const finalLedger = await options.rpc.getLatestLedger();
  invariant(
    finalLedger >= currentLedger,
    "RELAY_SIMULATION_FAILED",
    "RPC latest-ledger sequence moved backwards while authorizing",
    { before: currentLedger, after: finalLedger },
  );
  const invocationAfter = validateRelayTransaction(after, options.intent, {
    currentLedger: finalLedger,
    currentTime: readCurrentTime(),
    requireAllAuthorizations: false,
  });
  invocationAfter.auth.forEach((entry, index) => {
    const info = inspectAuthEntry(entry);
    if (info.address === options.signer.address) {
      invariant(
        info.signed &&
          info.signatureExpirationLedger ===
            options.intent.authExpirationLedger,
        "SIGNER_MISMATCH",
        "wallet did not produce a complete authorization",
        { index, signer: options.signer.address },
      );
    } else {
      invariant(
        entry.toXDR("base64") === beforeEntries[index],
        "RELAY_AUTHORIZATION_MISMATCH",
        "signing one role changed another role's authorization",
        { index },
      );
    }
  });

  return {
    version: 1,
    assembledTransaction: prepared.transaction.toJSON(),
  };
}
