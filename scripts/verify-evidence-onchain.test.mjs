import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  verifyInvokeOperation,
  verifyResultEvidence,
} from "./verify-evidence-onchain.mjs";

const requireFromSdk = createRequire(
  new URL("../packages/sdk/package.json", import.meta.url),
);
const sdk = requireFromSdk("@stellar/stellar-sdk");
const networkPassphrase = sdk.Networks.TESTNET;
const source = sdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const contract = sdk.Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 8),
).publicKey();

function hashArguments(argumentsXdr) {
  const framed = [];
  for (const argument of argumentsXdr) {
    const bytes = argument.toXDR();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    framed.push(length, bytes);
  }
  return createHash("sha256").update(Buffer.concat(framed)).digest("hex");
}

function normalizedOperation(operation) {
  return new sdk.TransactionBuilder(new sdk.Account(source, "0"), {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build().operations[0];
}

function deploymentContractId(preimage) {
  const hashPreimage = sdk.xdr.HashIdPreimage.envelopeTypeContractId(
    new sdk.xdr.HashIdPreimageContractId({
      networkId: sdk.hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: preimage,
    }),
  );
  return sdk.StrKey.encodeContract(sdk.hash(hashPreimage.toXDR()));
}

function resultEvidenceFixture() {
  const rawContractId = Buffer.alloc(32, 12);
  const event = new sdk.xdr.ContractEvent({
    ext: new sdk.xdr.ExtensionPoint(0),
    contractId: rawContractId,
    type: sdk.xdr.ContractEventType.contract(),
    body: new sdk.xdr.ContractEventBody(
      0,
      new sdk.xdr.ContractEventV0({
        topics: [sdk.xdr.ScVal.scvSymbol("job_created")],
        data: sdk.xdr.ScVal.scvU64(sdk.xdr.Uint64.fromString("7")),
      }),
    ),
  });
  const returnValue = sdk.xdr.ScVal.scvU64(sdk.xdr.Uint64.fromString("9"));
  const metadata = new sdk.xdr.TransactionMeta(
    4,
    new sdk.xdr.TransactionMetaV4({
      ext: new sdk.xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new sdk.xdr.SorobanTransactionMetaV2({
        ext: new sdk.xdr.SorobanTransactionMetaExt(0),
        returnValue,
      }),
      events: [
        new sdk.xdr.TransactionEvent({
          stage: sdk.xdr.TransactionEventStage.transactionEventStageAfterTx(),
          event,
        }),
      ],
      diagnosticEvents: [],
    }),
  );
  const eventXdr = event.toXDR("base64");
  return {
    result: {
      events: { contractEventsXdr: [[eventXdr]] },
      resultMetaXdr: metadata.toXDR("base64"),
    },
    raw: {
      hash: "3".repeat(64),
      contractEventsXdr: [eventXdr],
      decodedEvents: [
        {
          contractId: sdk.Address.contract(rawContractId).toString(),
          name: "job_created",
          decoded: { topics: [], data: "7" },
        },
      ],
      returnValueXdr: returnValue.toXDR("base64"),
    },
  };
}

test("verifies deployment Wasm, constructor arguments, preimage, and contract ID", () => {
  const wasmHash = Buffer.alloc(32, 9);
  const constructorArgs = [
    sdk.nativeToScVal(source, { type: "address" }),
    sdk.nativeToScVal(30n, { type: "u64" }),
  ];
  const operation = normalizedOperation(
    sdk.Operation.createCustomContract({
      address: new sdk.Address(source),
      wasmHash,
      salt: Buffer.alloc(32, 10),
      constructorArgs,
    }),
  );
  const raw = {
    hash: "1".repeat(64),
    label: "deploy_sla_hook",
    method: "__constructor",
    source,
    contractId: deploymentContractId(
      operation.func.createContractV2().contractIdPreimage(),
    ),
    authorizers: [],
    argumentsSha256: hashArguments(constructorArgs),
  };

  assert.doesNotThrow(() =>
    verifyInvokeOperation(
      operation,
      raw,
      sdk,
      networkPassphrase,
      wasmHash.toString("hex"),
    ),
  );
  assert.throws(
    () =>
      verifyInvokeOperation(
        operation,
        { ...raw, contractId: `C${"A".repeat(55)}` },
        sdk,
        networkPassphrase,
        wasmHash.toString("hex"),
      ),
    /derived contract ID/,
  );
  assert.throws(
    () =>
      verifyInvokeOperation(
        operation,
        raw,
        sdk,
        networkPassphrase,
        "0".repeat(64),
      ),
    /deployment Wasm hash/,
  );
});

test("verifies an existing-contract invocation and rejects operation sources", () => {
  const contractId = sdk.StrKey.encodeContract(Buffer.alloc(32, 11));
  const args = [sdk.nativeToScVal(1n, { type: "u64" })];
  const raw = {
    hash: "2".repeat(64),
    label: "refund.claim_refund",
    method: "claim_refund",
    source,
    contractId,
    authorizers: [],
    argumentsSha256: hashArguments(args),
  };
  const operation = normalizedOperation(
    sdk.Operation.invokeContractFunction({
      contract: contractId,
      function: raw.method,
      args,
    }),
  );
  const argumentContext = {
    kind: "scenario",
    scenario: {
      job_id: 1,
      job_snapshots: [{}],
    },
    transactionIndex: 0,
    identities: {},
    hookId: sdk.StrKey.encodeContract(Buffer.alloc(32, 12)),
  };
  assert.doesNotThrow(() =>
    verifyInvokeOperation(
      operation,
      raw,
      sdk,
      networkPassphrase,
      undefined,
      argumentContext,
    ),
  );
  assert.throws(
    () =>
      verifyInvokeOperation(operation, raw, sdk, networkPassphrase, undefined, {
        ...argumentContext,
        scenario: { ...argumentContext.scenario, job_id: 2 },
      }),
    /claim_refund.id/,
  );

  const sourced = normalizedOperation(
    sdk.Operation.invokeContractFunction({
      contract: contractId,
      function: raw.method,
      args,
      source: contract,
    }),
  );
  assert.throws(
    () =>
      verifyInvokeOperation(sourced, raw, sdk, networkPassphrase, undefined),
    /operation.source/,
  );
});

test("accepts Soroban Option::None as the null create_job provider", () => {
  const contractId = sdk.StrKey.encodeContract(Buffer.alloc(32, 13));
  const hookId = sdk.StrKey.encodeContract(Buffer.alloc(32, 14));
  const evaluator = sdk.Keypair.fromRawEd25519Seed(
    Buffer.alloc(32, 15),
  ).publicKey();
  const description = "Test live create_job decoding";
  const expiresAt = 1234n;
  const args = [
    sdk.nativeToScVal(source, { type: "address" }),
    sdk.xdr.ScVal.scvVoid(),
    sdk.nativeToScVal(evaluator, { type: "address" }),
    sdk.nativeToScVal(expiresAt, { type: "u64" }),
    sdk.nativeToScVal(description, { type: "string" }),
    sdk.nativeToScVal(hookId, { type: "address" }),
  ];
  const raw = {
    hash: "4".repeat(64),
    label: "completion.create_job",
    method: "create_job",
    source,
    contractId,
    authorizers: [],
    argumentsSha256: hashArguments(args),
  };
  const operation = normalizedOperation(
    sdk.Operation.invokeContractFunction({
      contract: contractId,
      function: raw.method,
      args,
    }),
  );
  const argumentContext = {
    kind: "scenario",
    scenario: {
      job_id: 1,
      job_snapshots: [
        {
          expires_at: expiresAt.toString(),
          description_sha256: createHash("sha256")
            .update(description)
            .digest("hex"),
        },
      ],
    },
    transactionIndex: 0,
    identities: { client: source, evaluator },
    hookId,
  };

  assert.doesNotThrow(() =>
    verifyInvokeOperation(
      operation,
      raw,
      sdk,
      networkPassphrase,
      undefined,
      argumentContext,
    ),
  );

  const providerArgs = [...args];
  providerArgs[1] = sdk.nativeToScVal(contract, { type: "address" });
  const providerOperation = normalizedOperation(
    sdk.Operation.invokeContractFunction({
      contract: contractId,
      function: raw.method,
      args: providerArgs,
    }),
  );
  assert.throws(
    () =>
      verifyInvokeOperation(
        providerOperation,
        { ...raw, argumentsSha256: hashArguments(providerArgs) },
        sdk,
        networkPassphrase,
        undefined,
        argumentContext,
      ),
    /create_job.provider/,
  );
});

test("binds retained event XDR, decoded events, and return value to raw evidence", () => {
  const { result, raw } = resultEvidenceFixture();
  assert.doesNotThrow(() => verifyResultEvidence(result, raw, sdk));
});

test("rejects retained contract event XDR that differs from raw evidence", () => {
  const { result, raw } = resultEvidenceFixture();
  const changedEvent = sdk.xdr.ContractEvent.fromXDR(
    raw.contractEventsXdr[0],
    "base64",
  );
  changedEvent
    .body()
    .v0()
    .data(sdk.xdr.ScVal.scvU64(sdk.xdr.Uint64.fromString("8")));
  const changedResult = {
    ...result,
    events: { contractEventsXdr: [[changedEvent.toXDR("base64")]] },
  };
  assert.throws(
    () => verifyResultEvidence(changedResult, raw, sdk),
    /contractEventsXdr/,
  );
});

test("rejects decoded event fields not derived from retained XDR", () => {
  const { result, raw } = resultEvidenceFixture();
  const changedRaw = {
    ...raw,
    decodedEvents: [{ ...raw.decodedEvents[0], name: "payment_released" }],
  };
  assert.throws(
    () => verifyResultEvidence(result, changedRaw, sdk),
    /decodedEvents/,
  );
});

test("rejects a return value that differs from retained result metadata", () => {
  const { result, raw } = resultEvidenceFixture();
  const changedRaw = {
    ...raw,
    returnValueXdr: sdk.xdr.ScVal.scvU64(sdk.xdr.Uint64.fromString("10")).toXDR(
      "base64",
    ),
  };
  assert.throws(
    () => verifyResultEvidence(result, changedRaw, sdk),
    /returnValueXdr/,
  );
});
