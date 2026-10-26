import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { commitmentToHex, commitmentBytes } from "@trionlabs/stellar-8183";
import { availableActions, amount, validateProfile } from "../src/model.js";
import { assertBinding } from "../src/identity.js";
import { assertSignedTransaction } from "../src/live.js";
import {
  encodeReceipt,
  makeReceipt,
  parseReceipt,
  matchReceiptJob,
} from "../src/receipt.js";
import { Metrics } from "../src/metrics.js";
import {
  Rehearsal,
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";

function setup() {
  const r = new Rehearsal();
  const record = r.create(
    {
      description: "Translate a product brief",
      provider: accounts.provider,
      evaluator: accounts.evaluator,
      expiresAt: BigInt(r.now + 60),
    },
    accounts.client,
  );
  return { r, id: record.job.id };
}
const hash = commitmentToHex(commitmentBytes("artifact bytes"));

describe("job lifecycle and role permissions", () => {
  it.each(["complete", "reject", "claim_refund"] as const)(
    "conserves funds through %s, then forbids reuse",
    async (final) => {
      const { r, id } = setup();
      const initial = [...r.balances.values()].reduce((a, b) => a + b, 0n);
      await r.act(id, "set_budget", accounts.client, { budget: 10_0000000n });
      await r.act(id, "fund", accounts.client);
      expect(r.escrow).toBe(10_0000000n);
      await expect(r.act(id, "fund", accounts.client)).rejects.toThrow(
        "cannot perform",
      );
      await expect(r.act(id, "complete", accounts.provider)).rejects.toThrow(
        "cannot perform",
      );
      if (final === "complete")
        await r.act(id, "submit", accounts.provider, { commitment: hash });
      if (final === "claim_refund") r.now += 60;
      const result = await r.act(
        id,
        final,
        final === "claim_refund" ? accounts.provider : accounts.evaluator,
      );
      expect(r.escrow).toBe(0n);
      expect([...r.balances.values()].reduce((a, b) => a + b, 0n)).toBe(
        initial,
      );
      expect(availableActions(result.job, accounts.client, r.now)).toEqual([]);
      await expect(r.act(id, final, accounts.evaluator)).rejects.toThrow();
      const receipt = await makeReceipt(profile, result.job, result.outcome!);
      expect(await parseReceipt(encodeReceipt(receipt))).toEqual(receipt);
      matchReceiptJob(receipt.receipt, result.job);
    },
  );
  it("cannot fund an expired Open job and permits either eligible expiry winner", async () => {
    const { r, id } = setup();
    await r.act(id, "set_budget", accounts.client, { budget: 10n });
    r.now += 60;
    await expect(r.act(id, "fund", accounts.client)).rejects.toThrow();
    const other = setup();
    await other.r.act(other.id, "set_budget", accounts.client, { budget: 10n });
    await other.r.act(other.id, "fund", accounts.client);
    await other.r.act(other.id, "submit", accounts.provider, {
      commitment: hash,
    });
    other.r.now += 60;
    expect(
      availableActions(
        other.r.read(other.id).job,
        accounts.evaluator,
        other.r.now,
      ),
    ).toEqual(["reject", "complete", "claim_refund"]);
  });
  it("does not mutate job or balance when commitment validation fails", async () => {
    const { r, id } = setup();
    await r.act(id, "set_budget", accounts.client, { budget: 10n });
    await r.act(id, "fund", accounts.client);
    await expect(
      r.act(id, "submit", accounts.provider, { commitment: "wrong" }),
    ).rejects.toThrow();
    expect(r.read(id).job.state.tag).toBe("Funded");
    expect(r.escrow).toBe(10n);
  });
});

describe("untrusted profiles, bindings, and receipts", () => {
  it("rejects network mismatch, credentials, real-value canary configuration, and excessive fees", () => {
    expect(() =>
      validateProfile({ ...profile, networkPassphrase: Networks.PUBLIC }),
    ).toThrow("passphrase");
    expect(() =>
      validateProfile({
        ...profile,
        rpcUrl: "https://user:password@example.org",
      }),
    ).toThrow("credentials");
    expect(() =>
      validateProfile({
        ...profile,
        id: "mainnet-canary",
        networkPassphrase: Networks.PUBLIC,
        symbol: "USDC",
        canaryAcknowledged: true,
      }),
    ).toThrow("DEMO8183");
    expect(() => validateProfile({ ...profile, maxFee: "100000001" })).toThrow(
      "ceiling",
    );
    expect(() => amount("0.00000001", 7)).toThrow();
  });
  it("refuses wrong network and changed provider in an identity snapshot", () => {
    const binding = {
      network: "testnet" as const,
      identityRegistry: profile.kernel,
      agentId: "4",
      provider: accounts.provider,
      resolvedAtLedger: 10,
    };
    expect(() =>
      assertBinding(profile, binding, accounts.provider),
    ).not.toThrow();
    expect(() => assertBinding(profile, binding, accounts.client)).toThrow(
      "no longer matches",
    );
    expect(() =>
      assertBinding(
        { ...profile, id: "mainnet-canary" },
        binding,
        accounts.provider,
      ),
    ).toThrow();
  });
  it("rejects altered bytes, extra fields, and mismatched terminal jobs", async () => {
    const { r, id } = setup();
    const result = await r.act(id, "reject", accounts.client);
    const file = await makeReceipt(profile, result.job, result.outcome!);
    const changed = structuredClone(file);
    changed.receipt.budget = "999";
    await expect(parseReceipt(JSON.stringify(changed))).rejects.toThrow("hash");
    await expect(
      parseReceipt(JSON.stringify({ ...file, privateKey: "do not allow" })),
    ).rejects.toThrow("fields");
    expect(() =>
      matchReceiptJob(file.receipt, {
        ...result.job,
        evaluator: accounts.provider,
      }),
    ).toThrow("does not match");
    const wrongMethod = structuredClone(file);
    wrongMethod.receipt.terminalTransaction.method = "complete";
    await expect(parseReceipt(JSON.stringify(wrongMethod))).rejects.toThrow(
      "method",
    );
  });
});

describe("wallet signing", () => {
  it("rejects source substitution, fee escalation, mutated body, and wrong signature", () => {
    const key = Keypair.random(),
      other = Keypair.random();
    const create = (fee = "100", memo?: string) => {
      const builder = new TransactionBuilder(
        new Account(key.publicKey(), "1"),
        { fee, networkPassphrase: Networks.TESTNET },
      )
        .addOperation(
          Operation.manageData({ name: memo ?? "test", value: "x" }),
        )
        .setTimeout(60);
      return builder.build();
    };
    const unsigned = create(),
      signed = TransactionBuilder.fromXDR(unsigned.toXDR(), Networks.TESTNET);
    signed.sign(key);
    expect(() =>
      assertSignedTransaction(
        unsigned.toXDR(),
        signed.toXDR(),
        profile,
        key.publicKey(),
      ),
    ).not.toThrow();
    expect(() =>
      assertSignedTransaction(
        unsigned.toXDR(),
        signed.toXDR(),
        profile,
        other.publicKey(),
      ),
    ).toThrow();
    const mutated = create("100", "changed");
    mutated.sign(key);
    expect(() =>
      assertSignedTransaction(
        unsigned.toXDR(),
        mutated.toXDR(),
        profile,
        key.publicKey(),
      ),
    ).toThrow("changed");
    const wrong = create();
    wrong.sign(other);
    expect(() =>
      assertSignedTransaction(
        unsigned.toXDR(),
        wrong.toXDR(),
        profile,
        key.publicKey(),
      ),
    ).toThrow("valid signature");
    const expensive = create("2000000");
    const signedExpensive = TransactionBuilder.fromXDR(
      expensive.toXDR(),
      Networks.TESTNET,
    );
    signedExpensive.sign(key);
    expect(() =>
      assertSignedTransaction(
        expensive.toXDR(),
        signedExpensive.toXDR(),
        profile,
        key.publicKey(),
      ),
    ).toThrow("ceiling");
  });
});

it("records only opt-in local events and erases them on clear", () => {
  const metrics = new Metrics();
  metrics.record("job_created");
  expect(JSON.parse(metrics.export("test")).events).toEqual([]);
  metrics.start();
  metrics.record("job_funded");
  expect(JSON.parse(metrics.export("test")).events).toHaveLength(2);
  expect(metrics.export("test")).not.toContain(accounts.client);
  metrics.clear();
  expect(JSON.parse(metrics.export("test")).events).toEqual([]);
});
