import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Address,
  SorobanDataBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { LiveCommerce, verifyOnChain } from "../src/live.js";
import { assertReviewedJob } from "../src/model.js";
import {
  defaultIdentityRegistry,
  resolveAgent,
  STELLAR_8004_IDENTITY_REGISTRIES,
} from "../src/identity.js";
import { JobMemory, type LocalStorage } from "../src/storage.js";
import { verifyBalanceAccounting } from "../src/accounting.js";
import { makeReceipt } from "../src/receipt.js";
import {
  Rehearsal,
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";

afterEach(() => vi.restoreAllMocks());
function openJob() {
  const r = new Rehearsal();
  return r.create(
    {
      description: "Research report",
      provider: accounts.provider,
      evaluator: accounts.evaluator,
      expiresAt: BigInt(r.now + 3600),
    },
    accounts.client,
  ).job;
}
const binding = {
  network: "testnet" as const,
  identityRegistry: profile.kernel,
  agentId: "10",
  provider: accounts.provider,
  resolvedAtLedger: 50,
};
function memory(): LocalStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("reviewed job terms", () => {
  it.each([
    "budget",
    "provider",
    "evaluator",
    "expires_at",
    "hook",
    "state",
    "desc",
  ] as const)(
    "blocks a changed %s before requesting a signature",
    async (field) => {
      const reviewed = { ...openJob(), budget: 10n };
      const changed = {
        ...reviewed,
        [field]: {
          budget: 20n,
          provider: accounts.client,
          evaluator: accounts.client,
          expires_at: reviewed.expires_at + 1n,
          hook: profile.kernel,
          state: { tag: "Funded", values: undefined },
          desc: "Changed terms",
        }[field],
      };
      expect(() => assertReviewedJob(changed, reviewed)).toThrow(
        "terms changed",
      );
      const sign = vi.fn(async () => "");
      const live = new LiveCommerce(profile, {
        address: accounts.client,
        sign,
      });
      vi.spyOn(live, "read").mockResolvedValue(changed);
      await expect(
        live.act(reviewed.id, "fund", {}, undefined, reviewed),
      ).rejects.toThrow("terms changed");
      expect(sign).not.toHaveBeenCalled();
    },
  );
});

describe("persistent identity snapshots", () => {
  it("restores an imported binding after a reload and scopes it to the deployment", () => {
    const storage = memory(),
      job = openJob();
    new JobMemory(storage, profile).save({ job, binding });
    const restored = new JobMemory(storage, profile).restore({ job });
    expect(restored.binding).toEqual(binding);
    expect(
      new JobMemory(storage, { ...profile, kernel: profile.token }).ids(),
    ).toEqual([]);
    expect(
      new JobMemory(storage, { ...profile, id: "mainnet-canary" }).ids(),
    ).toEqual([]);
  });
  it("discards a changed provider's snapshot and allows explicit direct-address mode", () => {
    const storage = memory(),
      job = openJob(),
      store = new JobMemory(storage, profile);
    store.save({ job, binding });
    expect(
      store.restore({ job: { ...job, provider: accounts.client } }).binding,
    ).toBeUndefined();
    store.save({ job, binding: undefined });
    expect(store.restore({ job }).binding).toBeUndefined();
    store.clear();
    expect(store.ids()).toEqual([]);
  });
  it("refuses to export a snapshot for a different provider", async () => {
    const job = {
      ...openJob(),
      state: { tag: "Rejected" as const, values: undefined },
    };
    await expect(
      makeReceipt(
        profile,
        job,
        { hash: "ab".repeat(32), ledger: 1, method: "reject" },
        { ...binding, provider: accounts.client },
      ),
    ).rejects.toThrow("no longer matches");
  });
});

describe("8004 contract reads", () => {
  it("defaults each network to the canonical Stellar8004 identity registry", () => {
    expect(defaultIdentityRegistry("testnet")).toBe(
      "CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH",
    );
    expect(defaultIdentityRegistry("mainnet-canary")).toBe(
      "CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35",
    );
    expect(Object.isFrozen(STELLAR_8004_IDENTITY_REGISTRIES)).toBe(true);
  });

  it("encodes the real u32 profile and records wallet and ledger", async () => {
    const simulation = vi
      .spyOn(rpc.Server.prototype, "simulateTransaction")
      .mockImplementation(async (tx) => {
        const op = tx.operations[0];
        if (op?.type !== "invokeHostFunction")
          throw new Error("Wrong operation");
        const call = op.func.invokeContract();
        expect(call.functionName().toString()).toBe("get_agent_wallet");
        expect(call.args()[0]!.switch().name).toBe("scvU32");
        expect(call.args()[0]!.u32()).toBe(10);
        return {
          id: "test",
          _parsed: true as const,
          latestLedger: 50,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "1",
          result: {
            auth: [],
            retval: new Address(accounts.provider).toScVal(),
          },
          events: [],
        };
      });
    expect(
      await resolveAgent(
        profile,
        { network: "testnet", identityRegistry: profile.kernel, agentId: "10" },
        accounts.client,
      ),
    ).toEqual(binding);
    expect(simulation).toHaveBeenCalledOnce();
    await expect(
      resolveAgent(
        profile,
        {
          network: "testnet",
          identityRegistry: profile.kernel,
          agentId: "4294967296",
        },
        accounts.client,
      ),
    ).rejects.toThrow("u32");
    expect(simulation).toHaveBeenCalledOnce();
  });
  it("fails before funding when an identity has no wallet or is unavailable", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      id: "test",
      _parsed: true,
      latestLedger: 50,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "1",
      result: { auth: [], retval: nativeToScVal(null) },
      events: [],
    });
    await expect(
      resolveAgent(
        profile,
        { network: "testnet", identityRegistry: profile.kernel, agentId: "10" },
        accounts.client,
      ),
    ).rejects.toThrow("no bound wallet");
  });
});

it("requires exact balance accounting for funding and payout", () => {
  const record = {
    jobId: "1",
    fundingTransaction: "ab".repeat(32),
    initial: { client: "100", provider: "0", evaluator: "0", escrow: "0" },
    funded: { client: "90", provider: "0", evaluator: "0", escrow: "10" },
    terminal: { client: "90", provider: "10", evaluator: "0", escrow: "0" },
  };
  expect(() => verifyBalanceAccounting(record, 10n, true)).not.toThrow();
  expect(() =>
    verifyBalanceAccounting(
      { ...record, terminal: { ...record.terminal, provider: "9" } },
      10n,
      true,
    ),
  ).toThrow("conserve");
  expect(() => verifyBalanceAccounting(record, 20n, true)).toThrow("Funding");
});

it("will not verify a receipt with the wrong immutable kernel token", async () => {
  const job = {
    ...openJob(),
    state: { tag: "Rejected" as const, values: undefined },
  };
  const receipt = await makeReceipt(profile, job, {
    hash: "ab".repeat(32),
    ledger: 10,
    method: "reject",
  });
  const reader = new LiveCommerce(profile, {
    address: accounts.client,
    sign: async () => "",
  });
  const token = vi
    .spyOn(reader, "tokenInfo")
    .mockRejectedValue(new Error("Configured token does not match the kernel"));
  const read = vi.spyOn(reader, "read");
  await expect(verifyOnChain(receipt, profile, reader)).rejects.toThrow(
    "token does not match",
  );
  expect(token).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});
