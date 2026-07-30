import {
  Account,
  Address,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { validateRelayTransaction } from "../src/relay/validation.js";
import {
  CURRENT_LEDGER,
  CURRENT_TIME,
  NETWORK,
  AUTH_EXPIRATION,
  relayFixture,
  relayIntent,
  replaceAuthorizationRoot,
} from "./helpers.js";

describe("relay envelope validation", () => {
  it("accepts an exact, signed intent", async () => {
    const fixture = await relayFixture({ signed: true });
    expect(() =>
      validateRelayTransaction(fixture.transaction, relayIntent(fixture), {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).not.toThrow();
  });

  it("rejects changed contract arguments", async () => {
    const fixture = await relayFixture({ signed: true });
    const intent = relayIntent(fixture);
    const changed = {
      ...intent,
      argumentXdr: [
        xdr.ScVal.scvU64(xdr.Uint64.fromString("8")).toXDR("base64"),
      ],
    };
    expect(() =>
      validateRelayTransaction(fixture.transaction, changed, {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/arguments changed/);
  });

  it("rejects excessive fees and stale time bounds", async () => {
    const expensive = await relayFixture({ signed: true, fee: "1001" });
    expect(() =>
      validateRelayTransaction(
        expensive.transaction,
        relayIntent(expensive, "1000"),
        {
          currentLedger: CURRENT_LEDGER,
          currentTime: CURRENT_TIME,
          requireAllAuthorizations: true,
        },
      ),
    ).toThrow(/fee exceeds/);

    const expired = await relayFixture({
      signed: true,
      maxTime: CURRENT_TIME,
    });
    expect(() =>
      validateRelayTransaction(expired.transaction, relayIntent(expired), {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/expired/);

    const nearlyExpired = await relayFixture({
      signed: true,
      maxTime: CURRENT_TIME + 14,
    });
    expect(() =>
      validateRelayTransaction(
        nearlyExpired.transaction,
        relayIntent(nearlyExpired),
        {
          currentLedger: CURRENT_LEDGER,
          currentTime: CURRENT_TIME,
          requireAllAuthorizations: true,
        },
      ),
    ).toThrow(/too close/);
  });

  it("rejects expired and unsigned authorization entries", async () => {
    const signed = await relayFixture({ signed: true });
    expect(() =>
      validateRelayTransaction(signed.transaction, relayIntent(signed), {
        currentLedger: 1_000,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/unsigned or expired/);

    const unsigned = await relayFixture();
    expect(() =>
      validateRelayTransaction(unsigned.transaction, relayIntent(unsigned), {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/unsigned/);
  });

  it("rejects additional operations", async () => {
    const fixture = await relayFixture({ signed: true });
    const original = fixture.transaction.operations[0]!;
    if (original.type !== "invokeHostFunction") {
      throw new Error("fixture operation is not invokeHostFunction");
    }
    const transaction = new TransactionBuilder(
      new Account(fixture.facilitator.publicKey(), "1"),
      { fee: "100", networkPassphrase: NETWORK },
    )
      .setTimebounds(0, CURRENT_TIME + 300)
      .addOperation(
        Operation.invokeHostFunction({
          func: original.func,
          auth: original.auth,
        }),
      )
      .addOperation(Operation.restoreFootprint({}))
      .build();
    const intent = {
      ...relayIntent(fixture),
      sequence: transaction.sequence,
    };
    expect(() =>
      validateRelayTransaction(transaction, intent, {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/exactly one operation/);
  });

  it("rejects a facilitator that also authorizes the role", async () => {
    const fixture = await relayFixture({ signed: true });
    const intent = relayIntent(fixture);
    const badIntent = {
      ...intent,
      facilitator: intent.authorizations[0]!.address,
    };
    expect(() =>
      validateRelayTransaction(fixture.transaction, badIntent, {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/source is not/);
  });

  it.each([
    {
      label: "contract",
      invokeArgs: (fixture: Awaited<ReturnType<typeof relayFixture>>) =>
        new xdr.InvokeContractArgs({
          contractAddress: Address.contract(Buffer.alloc(32, 99)).toScAddress(),
          functionName: "submit",
          args: [xdr.ScVal.scvU64(xdr.Uint64.fromString("7"))],
        }),
    },
    {
      label: "function",
      invokeArgs: (fixture: Awaited<ReturnType<typeof relayFixture>>) =>
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(fixture.contractId).toScAddress(),
          functionName: "complete",
          args: [xdr.ScVal.scvU64(xdr.Uint64.fromString("7"))],
        }),
    },
    {
      label: "arguments",
      invokeArgs: (fixture: Awaited<ReturnType<typeof relayFixture>>) =>
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(fixture.contractId).toScAddress(),
          functionName: "submit",
          args: [xdr.ScVal.scvU64(xdr.Uint64.fromString("8"))],
        }),
    },
  ])(
    "rejects an authorization root with changed $label",
    async ({ invokeArgs }) => {
      const original = await relayFixture();
      const fixture = replaceAuthorizationRoot(original, invokeArgs(original));
      expect(() =>
        validateRelayTransaction(fixture.transaction, relayIntent(fixture), {
          currentLedger: CURRENT_LEDGER,
          currentTime: CURRENT_TIME,
          requireAllAuthorizations: false,
        }),
      ).toThrow(/root must exactly match/);
    },
  );

  it("allows nested invocations beneath an exact authorization root", async () => {
    const original = await relayFixture();
    const operation = original.transaction.operations[0]!;
    if (operation.type !== "invokeHostFunction") {
      throw new Error("test fixture operation is not invokeHostFunction");
    }
    const invokeArgs = operation.func.invokeContract();
    const nestedArgs = new xdr.InvokeContractArgs({
      contractAddress: Address.contract(Buffer.alloc(32, 77)).toScAddress(),
      functionName: "transfer",
      args: [],
    });
    const nested = new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          nestedArgs,
        ),
      subInvocations: [],
    });
    const fixture = replaceAuthorizationRoot(original, invokeArgs, [nested]);
    const changedOperation = fixture.transaction.operations[0]!;
    if (changedOperation.type !== "invokeHostFunction") {
      throw new Error("test fixture operation is not invokeHostFunction");
    }
    changedOperation.auth![0] = await authorizeEntry(
      changedOperation.auth![0]!,
      fixture.role,
      AUTH_EXPIRATION,
      NETWORK,
    );

    expect(() =>
      validateRelayTransaction(fixture.transaction, relayIntent(fixture), {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).not.toThrow();
  });

  it("rejects an enforcing simulation that adds a ledger key", async () => {
    const fixture = await relayFixture({ signed: true });
    const intent = relayIntent(fixture);
    const extraKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(fixture.contractId).toScAddress(),
        key: xdr.ScVal.scvSymbol("Unexpected"),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const data = new SorobanDataBuilder()
      .setFootprint([], [extraKey])
      .setResources(100_000, 1_000, 1_000)
      .setResourceFee("0")
      .build();
    const changed = TransactionBuilder.cloneFrom(fixture.transaction, {
      sorobanData: data,
    }).build();

    expect(() =>
      validateRelayTransaction(changed, intent, {
        currentLedger: CURRENT_LEDGER,
        currentTime: CURRENT_TIME,
        requireAllAuthorizations: true,
      }),
    ).toThrow(/footprint or archived-entry/);
  });

  it("pins Protocol-23 archived-entry indices to exact read-write keys", async () => {
    const fixture = await relayFixture({ signed: true });
    const jobKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(fixture.contractId).toScAddress(),
        key: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Job"),
          xdr.ScVal.scvU64(xdr.Uint64.fromString("7")),
        ]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const baseData = new SorobanDataBuilder()
      .setFootprint([], [jobKey])
      .setResources(100_000, 1_000, 1_000)
      .setResourceFee("0")
      .build();
    const archivedData = new xdr.SorobanTransactionData({
      resources: baseData.resources(),
      resourceFee: baseData.resourceFee(),
      ext: new xdr.SorobanTransactionDataExt(
        1,
        new xdr.SorobanResourcesExtV0({
          archivedSorobanEntries: [0],
        }),
      ),
    });
    const hotTransaction = TransactionBuilder.cloneFrom(fixture.transaction, {
      sorobanData: baseData,
    }).build();
    const archivedTransaction = TransactionBuilder.cloneFrom(
      fixture.transaction,
      { sorobanData: archivedData },
    ).build();
    expect(hotTransaction).toBeInstanceOf(Transaction);

    expect(() =>
      validateRelayTransaction(
        archivedTransaction,
        relayIntent({ ...fixture, transaction: archivedTransaction }),
        {
          currentLedger: CURRENT_LEDGER,
          currentTime: CURRENT_TIME,
          requireAllAuthorizations: true,
        },
      ),
    ).not.toThrow();
    expect(() =>
      validateRelayTransaction(
        archivedTransaction,
        relayIntent({ ...fixture, transaction: hotTransaction }),
        {
          currentLedger: CURRENT_LEDGER,
          currentTime: CURRENT_TIME,
          requireAllAuthorizations: true,
        },
      ),
    ).toThrow(/footprint or archived-entry/);
  });
});
