import {
  Account,
  Address,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  hash,
  inspectAuthEntry,
  xdr,
} from "@stellar/stellar-sdk";
import {
  Err,
  KeypairSigner,
  Ok,
  type AssembledTransaction,
} from "@stellar/stellar-sdk/contract";
import { describe, expect, it, vi } from "vitest";

import { AgenticCommerceError } from "../src/errors.js";
import type {
  KernelAdapter,
  KernelMethod,
  PreparedInvocation,
} from "../src/kernel-types.js";
import { authorizeRelay } from "../src/relay/authorize.js";
import { facilitateRelay } from "../src/relay/facilitate.js";
import { prepareRelay } from "../src/relay/prepare.js";
import type { RelayRpc, RelayTransactionResult } from "../src/relay/types.js";
import {
  AUTH_EXPIRATION,
  CURRENT_LEDGER,
  CURRENT_TIME,
  NETWORK,
  relayFixture,
  relayIntent,
  replaceAuthorizationRoot,
} from "./helpers.js";

interface MutableAssembled<T> {
  built: Transaction;
  simulation: { latestLedger: number };
  signAuthEntries(options: {
    address?: string;
    expiration?: number | Promise<number>;
    signAuthEntry?: (
      entry: string,
      options?: { address?: string },
    ) => Promise<{
      signedAuthEntry: string;
      signerAddress?: string;
      error?: { message: string; code: number };
    }>;
  }): Promise<void>;
  toJSON(): string;
}

function mutablePrepared<T>(
  method: KernelMethod,
  transaction: Transaction,
): {
  readonly prepared: PreparedInvocation<T>;
  readonly assembled: MutableAssembled<T>;
  readonly adapter: KernelAdapter;
} {
  let serialized = 0;
  const assembled: MutableAssembled<T> = {
    built: transaction,
    simulation: { latestLedger: CURRENT_LEDGER },
    async signAuthEntries(options): Promise<void> {
      const operation = this.built.operations[0]!;
      if (operation.type !== "invokeHostFunction") {
        throw new Error("test operation is not invokeHostFunction");
      }
      const expiration = await options.expiration!;
      const entries = operation.auth ?? [];
      for (const [index, entry] of entries.entries()) {
        if (inspectAuthEntry(entry).address !== options.address) {
          continue;
        }
        entries[index] = await authorizeEntry(
          entry,
          async (preimage) => {
            const response = await options.signAuthEntry!(
              preimage.toXDR("base64"),
              { address: options.address },
            );
            if (response.error !== undefined) {
              throw new Error(response.error.message);
            }
            return Buffer.from(response.signedAuthEntry, "base64");
          },
          expiration,
          NETWORK,
        );
      }
    },
    toJSON(): string {
      serialized += 1;
      return `serialized-${serialized}`;
    },
  };
  const prepared: PreparedInvocation<T> = {
    method,
    transaction: assembled as unknown as AssembledTransaction<T>,
  };
  const adapter: KernelAdapter = {
    contractId: Address.contract(Buffer.alloc(32, 1)).toString(),
    networkPassphrase: NETWORK,
    rpcUrl: "https://rpc.test.invalid",
    invoke: async <R>() => prepared as unknown as PreparedInvocation<R>,
    deserialize: <R>() => prepared as unknown as PreparedInvocation<R>,
    decodeResult: <R>() => new Ok(7n) as unknown as R,
  };
  return { prepared, assembled, adapter };
}

function relayRpc(
  finalFactory?: (hash: string) => RelayTransactionResult,
): RelayRpc & { readonly submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async (transaction: Transaction) => ({
    hash: transaction.hash().toString("hex"),
    status: "PENDING" as const,
  }));
  return {
    getLatestLedger: async () => CURRENT_LEDGER,
    refresh: async (transaction, timeoutInSeconds) => {
      const operation = transaction.tx.operations()[0]!;
      return new TransactionBuilder(new Account(transaction.source, "10"), {
        fee: "100",
        networkPassphrase: NETWORK,
      })
        .setTimebounds(CURRENT_TIME - 1, CURRENT_TIME + timeoutInSeconds)
        .addOperation(operation)
        .build();
    },
    enforce: async (transaction) => {
      const data = new SorobanDataBuilder()
        .setResources(123_456, 789, 321)
        .setResourceFee("50")
        .build();
      return {
        transaction: TransactionBuilder.cloneFrom(transaction, { fee: "100" })
          .setSorobanData(data)
          .build(),
        latestLedger: CURRENT_LEDGER,
        minResourceFee: "50",
      };
    },
    submit,
    getTransaction: async (hash) =>
      finalFactory?.(hash) ?? {
        status: "SUCCESS",
        hash,
        latestLedger: CURRENT_LEDGER + 1,
        ledger: CURRENT_LEDGER + 1,
        createdAt: CURRENT_TIME + 5,
        returnValue: xdr.ScVal.scvU64(xdr.Uint64.fromString("7")),
        contractEventsXdr: [],
        diagnosticEventsXdr: [],
      },
  };
}

describe("relay workflow", () => {
  it("prepares a trusted intent and sequentially signs role auth", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, assembled, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    expect(relay.intent.authExpirationLedger).toBe(AUTH_EXPIRATION);
    expect(relay.intent.authorizations).toHaveLength(1);
    expect(Object.isFrozen(relay.intent.authorizations[0])).toBe(true);
    expect(relay.intent.authorizations[0]!.address).toBe(
      fixture.role.publicKey(),
    );

    const authorized = await authorizeRelay({
      adapter,
      rpc: relayRpc(),
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    expect(authorized.assembledTransaction).toBe("serialized-2");
    const operation = assembled.built.operations[0]!;
    if (operation.type !== "invokeHostFunction") {
      throw new Error("test operation is not invokeHostFunction");
    }
    expect(inspectAuthEntry(operation.auth![0]!).signed).toBe(true);
  });

  it("rejects an exact duplicate simulated authorization requirement", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const operation = fixture.transaction.operations[0]!;
    if (operation.type !== "invokeHostFunction") {
      throw new Error("test operation is not invokeHostFunction");
    }
    operation.auth!.push(operation.auth![0]!);
    const { prepared } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    expect(() =>
      prepareRelay(prepared, {
        maxFee: "1000",
        currentTime: CURRENT_TIME,
      }),
    ).toThrow(/duplicate authorization/);
  });

  it("rejects a non-strict authorization root before calling a wallet", async () => {
    const original = await relayFixture({ method: "create_job" });
    const maliciousArgs = new xdr.InvokeContractArgs({
      contractAddress: Address.contract(Buffer.alloc(32, 99)).toScAddress(),
      functionName: "drain",
      args: [Address.fromString(original.role.publicKey()).toScVal()],
    });
    const fixture = replaceAuthorizationRoot(original, maliciousArgs);
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const signAuthEntry = vi.fn(async () => ({
      signedAuthEntry: "",
      signerAddress: fixture.role.publicKey(),
    }));

    await expect(
      authorizeRelay({
        adapter,
        rpc: relayRpc(),
        request: {
          version: 1,
          assembledTransaction: prepared.transaction.toJSON(),
        },
        intent: relayIntent(fixture),
        signer: {
          address: fixture.role.publicKey(),
          signAuthEntry,
        },
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_AUTHORIZATION_MISMATCH" });
    expect(signAuthEntry).not.toHaveBeenCalled();
  });

  it("rechecks ledger expiry after a role wallet responds", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    let latestLedger = CURRENT_LEDGER;
    const rpc: RelayRpc = {
      ...relayRpc(),
      getLatestLedger: async () => latestLedger,
    };
    const baseSigner = new KeypairSigner(fixture.role, NETWORK);

    await expect(
      authorizeRelay({
        adapter,
        rpc,
        request: relay.request,
        intent: relay.intent,
        signer: {
          address: fixture.role.publicKey(),
          signAuthEntry: async (...arguments_) => {
            const response = await baseSigner.signAuthEntry(...arguments_);
            latestLedger = AUTH_EXPIRATION - 1;
            return response;
          },
        },
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_EXPIRED" });
  });

  it("enforces, verifies, submits, and unwraps an Ok result", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const rpc = relayRpc();
    const request = await authorizeRelay({
      adapter,
      rpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    const receipt = await facilitateRelay<bigint>({
      adapter,
      rpc,
      request,
      intent: relay.intent,
      facilitator: new KeypairSigner(fixture.facilitator, NETWORK),
      currentTime: CURRENT_TIME,
    });
    expect(receipt.result).toBe(7n);
    expect(receipt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.closedAt).toBe(
      new Date((CURRENT_TIME + 5) * 1_000).toISOString(),
    );
    expect(receipt.authorizers).toEqual([fixture.role.publicKey()]);
    expect(receipt.argumentsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.resources).toEqual({
      instructions: 123_456,
      readBytes: 789,
      writeBytes: 321,
      readOnlyEntries: 0,
      readWriteEntries: 0,
      declaredResourceFee: "50",
      inclusionFee: "100",
      totalFee: "150",
    });
    expect(rpc.submit).toHaveBeenCalledOnce();
    const submitted = rpc.submit.mock.calls[0]![0] as Transaction;
    expect(receipt.envelopeSha256).toBe(
      hash(Buffer.from(submitted.toXDR(), "base64")).toString("hex"),
    );
    expect(submitted.sequence).toBe("11");
    expect(submitted.sequence).not.toBe(fixture.transaction.sequence);
  });

  it("rejects an RPC hash that differs from the signed transaction", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const baseRpc = relayRpc();
    const badRpc: RelayRpc = {
      ...baseRpc,
      submit: async () => ({
        hash: "00".repeat(32),
        status: "PENDING",
      }),
    };
    const request = await authorizeRelay({
      adapter,
      rpc: badRpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    await expect(
      facilitateRelay({
        adapter,
        rpc: badRpc,
        request,
        intent: relay.intent,
        facilitator: new KeypairSigner(fixture.facilitator, NETWORK),
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_SUBMISSION_FAILED" });
  });

  it("surfaces a generated contract Err after successful submission", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const setup = mutablePrepared<Err<{ message: string }>>(
      "create_job",
      fixture.transaction,
    );
    const adapter: KernelAdapter = {
      ...setup.adapter,
      decodeResult: <R>() =>
        new Err({ message: "InvalidState" }) as unknown as R,
    };
    const relay = prepareRelay(setup.prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const rpc = relayRpc();
    const request = await authorizeRelay({
      adapter,
      rpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    await expect(
      facilitateRelay({
        adapter,
        rpc,
        request,
        intent: relay.intent,
        facilitator: new KeypairSigner(fixture.facilitator, NETWORK),
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({
      code: "CONTRACT_ERROR",
      message: "InvalidState",
    });
  });

  it("rejects a wallet that changes the envelope while signing", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const rpc = relayRpc();
    const request = await authorizeRelay({
      adapter,
      rpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    await expect(
      facilitateRelay({
        adapter,
        rpc,
        request,
        intent: relay.intent,
        facilitator: {
          address: fixture.facilitator.publicKey(),
          signTransaction: async (transactionXdr) => {
            const original = TransactionBuilder.fromXDR(
              transactionXdr,
              NETWORK,
            );
            if (!(original instanceof Transaction)) {
              throw new Error("unexpected fee bump");
            }
            const changed = TransactionBuilder.cloneFrom(original, {
              fee: "101",
            }).build();
            changed.sign(fixture.facilitator);
            return {
              signedTxXdr: changed.toXDR(),
              signerAddress: fixture.facilitator.publicKey(),
            };
          },
        },
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({
      code: "RELAY_ENVELOPE_MISMATCH",
    } satisfies Partial<AgenticCommerceError>);
  });

  it("rejects a refresh implementation that changes the signed invoke op", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const baseRpc = relayRpc();
    const badRpc: RelayRpc = {
      ...baseRpc,
      refresh: async (transaction) =>
        new TransactionBuilder(new Account(transaction.source, "10"), {
          fee: "100",
          networkPassphrase: NETWORK,
        })
          .setTimebounds(CURRENT_TIME - 1, CURRENT_TIME + 300)
          .addOperation(Operation.restoreFootprint({}))
          .build(),
    };
    const request = await authorizeRelay({
      adapter,
      rpc: badRpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    await expect(
      facilitateRelay({
        adapter,
        rpc: badRpc,
        request,
        intent: relay.intent,
        facilitator: new KeypairSigner(fixture.facilitator, NETWORK),
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_ENVELOPE_MISMATCH" });
  });

  it("rejects malformed Soroban resource fees before calling the facilitator wallet", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const baseRpc = relayRpc();
    const rpc: RelayRpc = {
      ...baseRpc,
      enforce: async (transaction) => {
        const data = new SorobanDataBuilder()
          .setResources(123_456, 789, 321)
          .setResourceFee("-1")
          .build();
        return {
          transaction: TransactionBuilder.cloneFrom(transaction, {
            fee: "100",
          })
            .setSorobanData(data)
            .build(),
          latestLedger: CURRENT_LEDGER,
          minResourceFee: "-1",
        };
      },
    };
    const request = await authorizeRelay({
      adapter,
      rpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });
    const signTransaction = vi.fn();

    await expect(
      facilitateRelay({
        adapter,
        rpc,
        request,
        intent: relay.intent,
        facilitator: {
          address: fixture.facilitator.publicKey(),
          signTransaction,
        },
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_SIMULATION_FAILED" });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("measures refreshed lifetime after an asynchronous refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CURRENT_TIME * 1_000);
    try {
      const fixture = await relayFixture({ method: "create_job" });
      const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
        "create_job",
        fixture.transaction,
      );
      const relay = prepareRelay(prepared, {
        maxFee: "1000",
        currentTime: CURRENT_TIME,
      });
      const baseRpc = relayRpc();
      const delayedRpc: RelayRpc = {
        ...baseRpc,
        refresh: async (transaction, timeoutInSeconds) => {
          vi.setSystemTime((CURRENT_TIME + 1) * 1_000);
          const operation = transaction.tx.operations()[0]!;
          const now = Math.floor(Date.now() / 1_000);
          return new TransactionBuilder(new Account(transaction.source, "10"), {
            fee: "100",
            networkPassphrase: NETWORK,
          })
            .setTimebounds(now - 1, now + timeoutInSeconds)
            .addOperation(operation)
            .build();
        },
      };
      const request = await authorizeRelay({
        adapter,
        rpc: delayedRpc,
        request: relay.request,
        intent: relay.intent,
        signer: new KeypairSigner(fixture.role, NETWORK),
        currentTime: CURRENT_TIME,
      });

      await expect(
        facilitateRelay({
          adapter,
          rpc: delayedRpc,
          request,
          intent: relay.intent,
          facilitator: new KeypairSigner(fixture.facilitator, NETWORK),
        }),
      ).resolves.toMatchObject({ status: "SUCCESS" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks authorization ledger expiry after facilitator approval", async () => {
    const fixture = await relayFixture({ method: "create_job" });
    const { prepared, adapter } = mutablePrepared<Ok<bigint>>(
      "create_job",
      fixture.transaction,
    );
    const relay = prepareRelay(prepared, {
      maxFee: "1000",
      currentTime: CURRENT_TIME,
    });
    const baseRpc = relayRpc();
    let latestLedger = CURRENT_LEDGER;
    const rpc: RelayRpc = {
      ...baseRpc,
      getLatestLedger: async () => latestLedger,
    };
    const request = await authorizeRelay({
      adapter,
      rpc,
      request: relay.request,
      intent: relay.intent,
      signer: new KeypairSigner(fixture.role, NETWORK),
      currentTime: CURRENT_TIME,
    });

    await expect(
      facilitateRelay({
        adapter,
        rpc,
        request,
        intent: relay.intent,
        facilitator: {
          address: fixture.facilitator.publicKey(),
          signTransaction: async (transactionXdr) => {
            const transaction = TransactionBuilder.fromXDR(
              transactionXdr,
              NETWORK,
            ) as Transaction;
            transaction.sign(fixture.facilitator);
            latestLedger = AUTH_EXPIRATION - 1;
            return {
              signedTxXdr: transaction.toXDR(),
              signerAddress: fixture.facilitator.publicKey(),
            };
          },
        },
        currentTime: CURRENT_TIME,
      }),
    ).rejects.toMatchObject({ code: "RELAY_EXPIRED" });
    expect(baseRpc.submit).not.toHaveBeenCalled();
  });
});
