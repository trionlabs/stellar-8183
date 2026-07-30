import { createHash } from "node:crypto";

import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { EvidenceRecorder } from "../src/evidence.js";
import {
  decodeContractEvent,
  hashRelayArguments,
} from "../src/relay/facilitate.js";
import type { RelayReceipt } from "../src/relay/types.js";
import { contractAddress, NETWORK } from "./helpers.js";

describe("raw evidence capture", () => {
  it("emits only whitelisted public data and resource metrics", () => {
    const secret = Keypair.random().secret();
    const client = Keypair.random().publicKey();
    const recorder = new EvidenceRecorder({
      network: "testnet",
      networkPassphrase: NETWORK,
      kernelContractId: contractAddress(),
      tokenContractId: contractAddress(2),
      tokenDecimals: 7,
      identities: { client },
      commitSha: "abc123",
    });
    const receipt: RelayReceipt<void> = {
      method: "set_hook",
      hash: "ab".repeat(32),
      status: "SUCCESS",
      ledger: 10,
      createdAt: 20,
      closedAt: "1970-01-01T00:00:20.000Z",
      latestLedger: 11,
      fee: "150",
      minResourceFee: "50",
      resources: {
        instructions: 100,
        readBytes: 20,
        writeBytes: 10,
        readOnlyEntries: 2,
        readWriteEntries: 1,
        declaredResourceFee: "50",
        inclusionFee: "100",
        totalFee: "150",
      },
      source: client,
      contractId: contractAddress(),
      authorizers: [client],
      argumentsSha256: "cd".repeat(32),
      envelopeSha256: "ef".repeat(32),
      contractEventsXdr: [],
      decodedEvents: [],
      diagnosticEventsXdr: [],
      result: undefined,
    };
    recorder.recordTransaction("allow_hook", receipt, [
      {
        label: "client",
        address: client,
        before: "10",
        after: "9",
        delta: "-1",
      },
    ]);
    recorder.recordJob("created", {
      id: 1n,
      client,
      provider: undefined,
      evaluator: Keypair.random().publicKey(),
      desc: "private testnet prompt",
      budget: 0n,
      expires_at: 30n,
      state: { tag: "Open", values: undefined },
      hook: undefined,
      work_hash: undefined,
      decision: undefined,
    });

    const capture = recorder.toCapture(new Date("2026-01-01T00:00:00Z"));
    expect(capture.schema).toBe("stellar-8183/raw-testnet-capture/v1");
    expect(capture.token).toEqual({
      contractId: contractAddress(2),
      decimals: 7,
    });
    expect(capture.transactions[0]!.resources.instructions).toBe(100);
    expect(capture.transactions[0]).toMatchObject({
      closedAt: "1970-01-01T00:00:20.000Z",
      authorizers: [client],
      argumentsSha256: "cd".repeat(32),
      envelopeSha256: "ef".repeat(32),
      balanceChanges: [{ delta: "-1" }],
    });
    expect(capture.jobs[0]).toMatchObject({
      descriptionSha256: createHash("sha256")
        .update("private testnet prompt", "utf8")
        .digest("hex"),
    });
    const json = recorder.toJSON();
    expect(json).not.toContain("private testnet prompt");
    expect(json).not.toContain(secret);
    expect(json).not.toMatch(/CLIENT_SECRET|privateKey|seed/i);
  });
});

describe("relay evidence commitments", () => {
  it("decodes a contract event without discarding the original XDR", () => {
    const rawContractId = Buffer.alloc(32, 9);
    const event = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: rawContractId as never,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("job_created")],
          data: xdr.ScVal.scvU64(xdr.Uint64.fromString("7")),
        }),
      ),
    });

    expect(decodeContractEvent(event.toXDR("base64"))).toEqual({
      contractId: Address.contract(rawContractId).toString(),
      name: "job_created",
      decoded: { topics: [], data: "7" },
    });
  });

  it("length-frames argument XDR before hashing", () => {
    expect(hashRelayArguments(["AA==", "AAA="])).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRelayArguments(["AA==", "AAA="])).not.toBe(
      hashRelayArguments(["AAAA"]),
    );
  });
});
