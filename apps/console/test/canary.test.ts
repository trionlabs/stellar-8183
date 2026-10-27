import { expect, it } from "vitest";
import {
  encodeCanaryEvidence,
  parseCanaryEvidence,
  type CanaryEvidence,
} from "../src/canary.js";
import { makeReceipt } from "../src/receipt.js";
import {
  Rehearsal,
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";

async function evidence(): Promise<CanaryEvidence> {
  const r = new Rehearsal();
  const receipts = [],
    balanceAccounting = [];
  let n = 0;
  for (const state of ["Completed", "Rejected", "Expired"] as const) {
    const job = r.create(
      {
        description: "Canary test",
        provider: accounts.provider,
        evaluator: accounts.evaluator,
        expiresAt: BigInt(r.now + 60),
      },
      accounts.client,
    ).job;
    const method = {
      Completed: "complete",
      Rejected: "reject",
      Expired: "claim_refund",
    }[state];
    receipts.push(
      await makeReceipt(
        profile,
        { ...job, budget: 10n, state: { tag: state, values: undefined } },
        { hash: (++n).toString(16).padStart(64, "0"), ledger: n, method },
      ),
    );
    balanceAccounting.push({
      jobId: job.id.toString(),
      fundingTransaction: (n + 10).toString(16).padStart(64, "0"),
      initial: { client: "100", provider: "0", evaluator: "0", escrow: "0" },
      funded: { client: "90", provider: "0", evaluator: "0", escrow: "10" },
      terminal: {
        client: state === "Completed" ? "90" : "100",
        provider: state === "Completed" ? "10" : "0",
        evaluator: "0",
        escrow: "0",
      },
    });
  }
  return {
    schema: "stellar-8183/canary-evidence/v1",
    profile,
    sourceCommit: "ab".repeat(20),
    hook: profile.token,
    kernelWasmSha256: "cd".repeat(32),
    hookWasmSha256: "ef".repeat(32),
    deploymentTransactions: {
      kernel: "11".repeat(32),
      hook: "22".repeat(32),
      admission: "33".repeat(32),
    },
    receipts,
    balanceAccounting,
    toolchain: {
      rustc: "rustc 1.96.0",
      stellarCli: "stellar 27.0.0",
      node: "v22.22.0",
      pnpm: "pnpm@11.9.0",
      sorobanSdk: "27.0.3",
      stellarSdk: "16.2.0",
    },
    evidenceType: "author-run",
    independentParticipant: false,
  };
}

it("validates a separate, complete canary evidence profile", async () => {
  const input = await evidence();
  expect(await parseCanaryEvidence(encodeCanaryEvidence(input))).toEqual(input);
});
it("rejects duplicate jobs, missing paths, wrong deployment, missing toolchain, and bad accounting", async () => {
  const input = await evidence();
  await expect(
    parseCanaryEvidence(
      JSON.stringify({
        ...input,
        receipts: [input.receipts[0], input.receipts[0], input.receipts[2]],
      }),
    ),
  ).rejects.toThrow("Duplicate");
  await expect(
    parseCanaryEvidence(JSON.stringify({ ...input, sourceCommit: "main" })),
  ).rejects.toThrow("source commit");
  await expect(
    parseCanaryEvidence(
      JSON.stringify({
        ...input,
        receipts: input.receipts.slice(0, 2),
        balanceAccounting: input.balanceAccounting.slice(0, 2),
      }),
    ),
  ).rejects.toThrow("at least three");
  await expect(
    parseCanaryEvidence(
      JSON.stringify({
        ...input,
        toolchain: { ...input.toolchain, stellarSdk: "unreviewed" },
      }),
    ),
  ).rejects.toThrow("pinned");
  await expect(
    parseCanaryEvidence(JSON.stringify({ ...input, balanceAccounting: [] })),
  ).rejects.toThrow("accounting");
});
