import { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { StellarRelayRpc } from "../src/relay/rpc.js";

function transactionResponse(createdAt: unknown) {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: "a".repeat(64),
    latestLedger: 1_001,
    ledger: 1_000,
    createdAt,
    resultXdr: {
      toXDR: () => Buffer.from("result"),
    },
    returnValue: undefined,
    events: { contractEventsXdr: [] },
    diagnosticEventsXdr: [],
  };
}

describe("StellarRelayRpc", () => {
  it("normalizes a runtime RPC string close timestamp", async () => {
    const transport = new StellarRelayRpc("https://rpc.test.invalid");
    vi.spyOn(transport.server, "getTransaction").mockResolvedValue(
      transactionResponse("1767225600") as never,
    );

    await expect(
      transport.getTransaction("a".repeat(64)),
    ).resolves.toMatchObject({
      status: "SUCCESS",
      createdAt: 1_767_225_600,
    });
  });

  it.each(["1767225600.5", "9007199254740992", 0, undefined])(
    "rejects an invalid runtime RPC close timestamp %s",
    async (createdAt) => {
      const transport = new StellarRelayRpc("https://rpc.test.invalid");
      vi.spyOn(transport.server, "getTransaction").mockResolvedValue(
        transactionResponse(createdAt) as never,
      );

      await expect(
        transport.getTransaction("a".repeat(64)),
      ).rejects.toMatchObject({
        code: "RELAY_SUBMISSION_FAILED",
      });
    },
  );
});
