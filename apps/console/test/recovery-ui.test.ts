import { expect, it } from "vitest";
import { RecoveryJournal } from "../src/recovery.js";
import {
  rehearsalAccounts as accounts,
  rehearsalProfile as profile,
} from "../src/rehearsal.js";
import type { LocalStorage } from "../src/storage.js";
import { JobMemory } from "../src/storage.js";
import { Rehearsal } from "../src/rehearsal.js";
const pending = {
  hash: "ab".repeat(32),
  source: accounts.client,
  method: "create_job" as const,
};
const outcome = { hash: pending.hash, method: "create_job", ledger: 12 };
function storage(): LocalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
it("blocks a duplicate create after reload until the signed hash is resolved", () => {
  const disk = storage();
  new RecoveryJournal(profile, disk).track(pending);
  const reloaded = new RecoveryJournal(profile, disk);
  expect(reloaded.blocksCreate(accounts.client)).toBe(true);
  expect(reloaded.blocksCreate(accounts.provider)).toBe(false);
  expect(
    new RecoveryJournal({ ...profile, kernel: profile.token }, disk).pending(),
  ).toEqual([]);
  reloaded.confirmed(42n, outcome);
  expect(reloaded.pending()).toEqual([]);
  expect(reloaded.missing([])).toEqual([42n]);
  expect(reloaded.missing([42n])).toEqual([]);
});
it("retains recovery metadata in memory when browser persistence fails", () => {
  const unavailable: LocalStorage = {
    getItem: () => {
      throw new Error("Blocked");
    },
    setItem: () => {
      throw new Error("Blocked");
    },
    removeItem: () => {
      throw new Error("Blocked");
    },
  };
  const journal = new RecoveryJournal(profile, unavailable);
  journal.track(pending);
  expect(journal.storageUnavailable).toBe(true);
  expect(journal.blocksCreate(accounts.client)).toBe(true);
  journal.confirmed(42n, outcome);
  expect(journal.blocksCreate(accounts.client)).toBe(false);
  expect(journal.missing([])).toEqual([42n]);
  journal.observed(42n);
  expect(journal.missing([])).toEqual([]);
});
it("keeps unrelated job recovery and expiry-refund paths available", () => {
  const journal = new RecoveryJournal(profile, storage());
  journal.track({ ...pending, method: "fund", jobId: "8" });
  expect(journal.blocksJob(8n)).toBe(true);
  expect(journal.blocksJob(9n)).toBe(false);
  expect(journal.blocksCreate(accounts.client)).toBe(false);
  journal.clear(pending.hash);
  expect(journal.blocksJob(8n)).toBe(false);
});
it("preserves an advisory binding during read-only recovery and clears it on explicit provider assignment", () => {
  const disk = storage();
  const rehearsal = new Rehearsal();
  const record = rehearsal.create(
    {
      description: "Recovery fixture",
      provider: accounts.provider,
      evaluator: accounts.evaluator,
      expiresAt: BigInt(rehearsal.now + 3600),
    },
    accounts.client,
  );
  const binding = {
    network: profile.id,
    identityRegistry: profile.kernel,
    agentId: "10",
    provider: accounts.provider,
    resolvedAtLedger: 50,
  };
  new JobMemory(disk, profile).save({ ...record, binding });
  const journal = new RecoveryJournal(profile, disk);
  journal.confirmed(record.job.id, { ...outcome, method: "fund" });
  expect(new JobMemory(disk, profile).restore(record).binding).toEqual(binding);
  journal.confirmed(record.job.id, { ...outcome, method: "set_provider" });
  expect(new JobMemory(disk, profile).restore(record).binding).toBeUndefined();
});
