import {
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { SignTransaction } from "@stellar/stellar-sdk/contract";

import { invariant } from "./errors.js";
import type { GuardedRestoreOptions } from "./kernel-types.js";

const UINT_PATTERN = /^(0|[1-9]\d*)$/;

function parseUnsigned(value: string, label: string): bigint {
  invariant(
    UINT_PATTERN.test(value),
    "RESTORATION_POLICY_MISMATCH",
    `${label} must be an unsigned decimal integer`,
    { [label]: value },
  );
  return BigInt(value);
}

function regularTransaction(
  transactionXdr: string,
  networkPassphrase: string,
): Transaction {
  let parsed;
  try {
    parsed = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch (cause) {
    throw new TypeError("restore signer received invalid transaction XDR", {
      cause,
    });
  }
  invariant(
    parsed instanceof Transaction,
    "UNSUPPORTED_TRANSACTION",
    "restore signer does not accept fee-bump transactions",
  );
  return parsed;
}

function canonicalLedgerKeys(values: readonly string[]): readonly string[] {
  invariant(
    values.length > 0,
    "RESTORATION_POLICY_MISMATCH",
    "restoration policy must contain at least one expected ledger key",
  );
  const canonical = values.map((value, index) => {
    try {
      return xdr.LedgerKey.fromXDR(value, "base64").toXDR("base64");
    } catch (cause) {
      throw new TypeError(
        `expectedLedgerKeyXdr[${index}] is not a LedgerKey XDR value`,
        { cause },
      );
    }
  });
  invariant(
    new Set(canonical).size === canonical.length,
    "RESTORATION_POLICY_MISMATCH",
    "restoration policy contains a duplicate ledger key",
  );
  return canonical.toSorted();
}

function validateRestoreTransaction(
  transaction: Transaction,
  options: GuardedRestoreOptions,
  expectedLedgerKeys: readonly string[],
  currentTime: number,
): void {
  invariant(
    transaction.networkPassphrase === options.networkPassphrase,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction uses the wrong network passphrase",
  );
  invariant(
    transaction.source === options.signer.address,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction uses the wrong source account",
    {
      actual: transaction.source,
      expected: options.signer.address,
    },
  );
  invariant(
    transaction.signatures.length === 0,
    "RESTORATION_POLICY_MISMATCH",
    "unsigned restoration request already contains envelope signatures",
    { signatureCount: transaction.signatures.length },
  );
  invariant(
    transaction.operations.length === 1 &&
      transaction.operations[0]?.type === "restoreFootprint" &&
      transaction.operations[0].source === undefined,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction must contain one source-less restoreFootprint operation",
  );
  invariant(
    transaction.memo.type === "none",
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction must not contain a memo",
  );
  invariant(
    transaction.ledgerBounds === undefined &&
      transaction.minAccountSequence === undefined &&
      transaction.minAccountSequenceAge === undefined &&
      transaction.minAccountSequenceLedgerGap === undefined &&
      transaction.extraSigners === undefined,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction contains unsupported preconditions",
  );

  const bounds = transaction.timeBounds;
  invariant(
    bounds !== undefined,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction must have finite time bounds",
  );
  const minTime = parseUnsigned(bounds.minTime, "minTime");
  const maxTime = parseUnsigned(bounds.maxTime, "maxTime");
  const lifetime = options.maxTransactionLifetimeSeconds ?? 300;
  invariant(
    Number.isSafeInteger(lifetime) && lifetime >= 1 && lifetime <= 3_600,
    "RESTORATION_POLICY_MISMATCH",
    "restoration lifetime ceiling must be between 1 and 3,600 seconds",
  );
  invariant(
    minTime <= BigInt(currentTime) &&
      maxTime !== 0n &&
      maxTime > BigInt(currentTime) &&
      maxTime - BigInt(currentTime) <= BigInt(lifetime),
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction has invalid or excessive time bounds",
    { minTime: bounds.minTime, maxTime: bounds.maxTime, currentTime, lifetime },
  );

  const fee = parseUnsigned(transaction.fee, "fee");
  const maxFee = parseUnsigned(options.maxFee, "maxFee");
  invariant(
    maxFee > 0n && fee <= maxFee,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction exceeds the fee ceiling",
    { fee: transaction.fee, maxFee: options.maxFee },
  );

  const envelope = transaction.toEnvelope();
  invariant(
    envelope.switch().value === xdr.EnvelopeType.envelopeTypeTx().value,
    "UNSUPPORTED_TRANSACTION",
    "restoration must use a v1 transaction envelope",
  );
  const extension = envelope.v1().tx().ext();
  invariant(
    extension.switch() === 1,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction omitted Soroban resource data",
  );
  const data = extension.sorobanData();
  invariant(
    data.ext().switch() === 0,
    "RESTORATION_POLICY_MISMATCH",
    "separate restoreFootprint transactions must not contain archived-entry extensions",
  );
  const resourceFee = BigInt(data.resourceFee().toString());
  invariant(
    resourceFee >= 0n && fee >= resourceFee,
    "RESTORATION_POLICY_MISMATCH",
    "restoration transaction contains inconsistent resource fees",
    { fee: transaction.fee, resourceFee: resourceFee.toString() },
  );
  const footprint = data.resources().footprint();
  invariant(
    footprint.readOnly().length === 0,
    "RESTORATION_POLICY_MISMATCH",
    "restoration footprint must not contain read-only keys",
    { readOnlyCount: footprint.readOnly().length },
  );
  const actualKeys = footprint
    .readWrite()
    .map((key) => key.toXDR("base64"))
    .toSorted();
  invariant(
    actualKeys.length === expectedLedgerKeys.length &&
      actualKeys.every((key, index) => key === expectedLedgerKeys[index]),
    "RESTORATION_POLICY_MISMATCH",
    "restoration footprint does not exactly match the trusted ledger-key allowlist",
    {
      actualCount: actualKeys.length,
      expectedCount: expectedLedgerKeys.length,
    },
  );
}

/**
 * Wrap a facilitator wallet with a fail-closed policy for the separate
 * restoreFootprint transaction generated by Stellar SDK 16.2.
 */
export function createGuardedRestoreSigner(
  options: GuardedRestoreOptions,
): SignTransaction {
  invariant(
    StrKey.isValidEd25519PublicKey(options.signer.address),
    "RESTORATION_POLICY_MISMATCH",
    "restoration signer must be a G-address",
    { address: options.signer.address },
  );
  const expectedLedgerKeys = canonicalLedgerKeys(options.expectedLedgerKeyXdr);
  parseUnsigned(options.maxFee, "maxFee");

  return async (transactionXdr, signerOptions) => {
    invariant(
      signerOptions?.networkPassphrase === options.networkPassphrase,
      "RESTORATION_POLICY_MISMATCH",
      "wallet request uses the wrong network passphrase",
    );
    invariant(
      signerOptions?.address === undefined ||
        signerOptions.address === options.signer.address,
      "RESTORATION_POLICY_MISMATCH",
      "wallet request names the wrong signer address",
    );
    invariant(
      signerOptions?.submit !== true,
      "RESTORATION_POLICY_MISMATCH",
      "guarded restoration never permits wallet-side submission",
    );
    invariant(
      signerOptions?.submitUrl === undefined,
      "RESTORATION_POLICY_MISMATCH",
      "guarded restoration never permits a wallet submission URL",
    );
    const currentTime = options.currentTime ?? Math.floor(Date.now() / 1_000);
    invariant(
      Number.isSafeInteger(currentTime) && currentTime >= 0,
      "RESTORATION_POLICY_MISMATCH",
      "restoration current time must be a non-negative Unix timestamp",
    );
    const transaction = regularTransaction(
      transactionXdr,
      options.networkPassphrase,
    );
    validateRestoreTransaction(
      transaction,
      options,
      expectedLedgerKeys,
      currentTime,
    );

    const response = await options.signer.signTransaction(transactionXdr, {
      address: options.signer.address,
      networkPassphrase: options.networkPassphrase,
      submit: false,
    });
    invariant(
      response.error === undefined,
      "SIGNER_MISMATCH",
      "restoration wallet returned an error",
      { error: response.error },
    );
    invariant(
      response.signerAddress === undefined ||
        response.signerAddress === options.signer.address,
      "SIGNER_MISMATCH",
      "restoration wallet signed with a different address",
      {
        actual: response.signerAddress,
        expected: options.signer.address,
      },
    );
    const signed = regularTransaction(
      response.signedTxXdr,
      options.networkPassphrase,
    );
    invariant(
      signed.signatureBase().equals(transaction.signatureBase()),
      "RESTORATION_POLICY_MISMATCH",
      "restoration wallet changed the transaction body while signing",
    );
    invariant(
      signed.signatures.length === 1 &&
        Keypair.fromPublicKey(options.signer.address).verify(
          signed.hash(),
          signed.signatures[0]!.signature(),
        ),
      "SIGNER_MISMATCH",
      "restoration wallet did not add exactly one valid facilitator signature",
      { signatureCount: signed.signatures.length },
    );
    const finalTime = options.currentTime ?? Math.floor(Date.now() / 1_000);
    const finalBounds = signed.timeBounds;
    invariant(
      finalBounds !== undefined &&
        BigInt(finalBounds.minTime) <= BigInt(finalTime) &&
        BigInt(finalBounds.maxTime) > BigInt(finalTime),
      "RESTORATION_POLICY_MISMATCH",
      "restoration transaction expired while awaiting the wallet",
      {
        maxTime: finalBounds?.maxTime,
        currentTime: finalTime,
      },
    );
    return {
      signedTxXdr: signed.toXDR(),
      signerAddress: options.signer.address,
    };
  };
}
