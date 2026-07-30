import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { createGuardedRestoreSigner } from "../src/restoration.js";
import type { GuardedRestoreOptions } from "../src/kernel-types.js";

const CURRENT_TIME = 1_900_000_000;

function contractDataKey(byte: number): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.contract(Buffer.alloc(32, byte)).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function restoreTransaction(
  source: string,
  keys: readonly xdr.LedgerKey[],
  options: {
    readonly fee?: string;
    readonly minTime?: number;
    readonly maxTime?: number;
    readonly readOnly?: readonly xdr.LedgerKey[];
    readonly extraOperation?: boolean;
  } = {},
): Transaction {
  const data = new SorobanDataBuilder()
    .setFootprint([...(options.readOnly ?? [])], [...keys])
    .setResources(10_000, 1_000, 1_000)
    .setResourceFee("50")
    .build();
  const builder = new TransactionBuilder(new Account(source, "1"), {
    fee: options.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setSorobanData(data)
    .setTimebounds(
      options.minTime ?? CURRENT_TIME - 1,
      options.maxTime ?? CURRENT_TIME + 300,
    )
    .addOperation(Operation.restoreFootprint({}));
  if (options.extraOperation === true) {
    builder.addOperation(Operation.restoreFootprint({}));
  }
  return builder.build();
}

function policy(
  keypair: Keypair,
  keys: readonly xdr.LedgerKey[],
  signTransaction = vi.fn(async (transactionXdr: string) => {
    const transaction = TransactionBuilder.fromXDR(
      transactionXdr,
      Networks.TESTNET,
    );
    if (!(transaction instanceof Transaction)) {
      throw new Error("unexpected fee-bump transaction");
    }
    transaction.sign(keypair);
    return {
      signedTxXdr: transaction.toXDR(),
      signerAddress: keypair.publicKey(),
    };
  }),
): GuardedRestoreOptions {
  return {
    signer: {
      address: keypair.publicKey(),
      signTransaction,
    },
    networkPassphrase: Networks.TESTNET,
    expectedLedgerKeyXdr: keys.map((key) => key.toXDR("base64")),
    maxFee: "1000",
    currentTime: CURRENT_TIME,
  };
}

describe("guarded restoration signer", () => {
  it("signs one exact, bounded restore footprint without wallet submission", async () => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1), contractDataKey(2)];
    const options = policy(keypair, keys);
    const signer = createGuardedRestoreSigner(options);
    const response = await signer(
      restoreTransaction(keypair.publicKey(), keys.reverse()).toXDR(),
      {
        address: keypair.publicKey(),
        networkPassphrase: Networks.TESTNET,
        submit: false,
      },
    );

    expect(response.error).toBeUndefined();
    const signed = TransactionBuilder.fromXDR(
      response.signedTxXdr,
      Networks.TESTNET,
    );
    expect(signed).toBeInstanceOf(Transaction);
    expect((signed as Transaction).signatures).toHaveLength(1);
  });

  it.each([
    {
      label: "an unexpected ledger key",
      transaction: (source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(source, [keys[0]!, contractDataKey(99)]),
    },
    {
      label: "a read-only footprint",
      transaction: (source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(source, keys, { readOnly: [contractDataKey(9)] }),
    },
    {
      label: "an excessive fee",
      transaction: (source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(source, keys, { fee: "1001" }),
    },
    {
      label: "multiple operations",
      transaction: (source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(source, keys, { extraOperation: true }),
    },
    {
      label: "the wrong source",
      transaction: (_source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(Keypair.random().publicKey(), keys),
    },
    {
      label: "expired bounds",
      transaction: (source: string, keys: readonly xdr.LedgerKey[]) =>
        restoreTransaction(source, keys, { maxTime: CURRENT_TIME }),
    },
  ])("rejects $label before calling the wallet", async ({ transaction }) => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1), contractDataKey(2)];
    const delegate = vi.fn();
    const signer = createGuardedRestoreSigner(policy(keypair, keys, delegate));

    await expect(
      signer(transaction(keypair.publicKey(), keys).toXDR(), {
        networkPassphrase: Networks.TESTNET,
        submit: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORATION_POLICY_MISMATCH" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects wallet-side submission before calling the wallet", async () => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1)];
    const delegate = vi.fn();
    const signer = createGuardedRestoreSigner(policy(keypair, keys, delegate));

    await expect(
      signer(restoreTransaction(keypair.publicKey(), keys).toXDR(), {
        networkPassphrase: Networks.TESTNET,
        submit: true,
      }),
    ).rejects.toMatchObject({ code: "RESTORATION_POLICY_MISMATCH" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a missing or changed wallet network before signing", async () => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1)];
    const delegate = vi.fn();
    const signer = createGuardedRestoreSigner(policy(keypair, keys, delegate));
    const transactionXdr = restoreTransaction(
      keypair.publicKey(),
      keys,
    ).toXDR();

    await expect(signer(transactionXdr)).rejects.toMatchObject({
      code: "RESTORATION_POLICY_MISMATCH",
    });
    await expect(
      signer(transactionXdr, {
        networkPassphrase: Networks.PUBLIC,
        submit: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORATION_POLICY_MISMATCH" });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a wallet that mutates the restoration body", async () => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1)];
    const maliciousWallet = vi.fn(async (transactionXdr: string) => {
      const transaction = TransactionBuilder.fromXDR(
        transactionXdr,
        Networks.TESTNET,
      );
      if (!(transaction instanceof Transaction)) {
        throw new Error("unexpected fee bump");
      }
      const changed = TransactionBuilder.cloneFrom(transaction, {
        fee: "101",
      }).build();
      changed.sign(keypair);
      return {
        signedTxXdr: changed.toXDR(),
        signerAddress: keypair.publicKey(),
      };
    });
    const signer = createGuardedRestoreSigner(
      policy(keypair, keys, maliciousWallet),
    );

    await expect(
      signer(restoreTransaction(keypair.publicKey(), keys).toXDR(), {
        networkPassphrase: Networks.TESTNET,
        submit: false,
      }),
    ).rejects.toMatchObject({ code: "RESTORATION_POLICY_MISMATCH" });
  });

  it.each([
    {
      label: "wrong signature",
      wallet: (_expected: Keypair) => async (transactionXdr: string) => {
        const transaction = TransactionBuilder.fromXDR(
          transactionXdr,
          Networks.TESTNET,
        ) as Transaction;
        transaction.sign(Keypair.random());
        return { signedTxXdr: transaction.toXDR() };
      },
    },
    {
      label: "multiple signatures",
      wallet: (expected: Keypair) => async (transactionXdr: string) => {
        const transaction = TransactionBuilder.fromXDR(
          transactionXdr,
          Networks.TESTNET,
        ) as Transaction;
        transaction.sign(expected, Keypair.random());
        return { signedTxXdr: transaction.toXDR() };
      },
    },
  ])("rejects a wallet returning a $label", async ({ wallet }) => {
    const keypair = Keypair.random();
    const keys = [contractDataKey(1)];
    const signer = createGuardedRestoreSigner(
      policy(keypair, keys, vi.fn(wallet(keypair))),
    );

    await expect(
      signer(restoreTransaction(keypair.publicKey(), keys).toXDR(), {
        networkPassphrase: Networks.TESTNET,
        submit: false,
      }),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
  });

  it("rechecks expiry after a slow wallet response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CURRENT_TIME * 1_000);
    try {
      const keypair = Keypair.random();
      const keys = [contractDataKey(1)];
      const base = policy(keypair, keys);
      const { currentTime: _currentTime, ...liveBase } = base;
      const livePolicy: GuardedRestoreOptions = {
        ...liveBase,
        signer: {
          address: keypair.publicKey(),
          signTransaction: async (transactionXdr) => {
            vi.setSystemTime((CURRENT_TIME + 301) * 1_000);
            const transaction = TransactionBuilder.fromXDR(
              transactionXdr,
              Networks.TESTNET,
            ) as Transaction;
            transaction.sign(keypair);
            return { signedTxXdr: transaction.toXDR() };
          },
        },
      };
      const signer = createGuardedRestoreSigner(livePolicy);

      await expect(
        signer(restoreTransaction(keypair.publicKey(), keys).toXDR(), {
          networkPassphrase: Networks.TESTNET,
          submit: false,
        }),
      ).rejects.toMatchObject({ code: "RESTORATION_POLICY_MISMATCH" });
    } finally {
      vi.useRealTimers();
    }
  });
});
