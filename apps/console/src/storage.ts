import { assertBinding } from "./identity.js";
import { assertPendingSubmission, type PendingSubmission } from "./live.js";
import {
  terminal,
  uint,
  type AgentBinding,
  type Outcome,
  type Profile,
  type RecordJob,
} from "./model.js";

export interface LocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface Saved {
  ids: string[];
  jobs: Record<string, { binding?: AgentBinding; outcome?: Outcome }>;
}
export class JobMemory {
  private key: string;
  private pendingKey: string;
  constructor(
    private storage: LocalStorage,
    private profile: Profile,
  ) {
    this.key = `8183:v1:${profile.id}:${profile.kernel}:${profile.token}`;
    this.pendingKey = `${this.key}:pending`;
  }
  private read(): Saved {
    try {
      const text = this.storage.getItem(this.key);
      if (!text || text.length > 500_000) return { ids: [], jobs: {} };
      const saved = JSON.parse(text) as Saved;
      if (
        !Array.isArray(saved.ids) ||
        saved.ids.length > 100 ||
        !saved.jobs ||
        typeof saved.jobs !== "object"
      )
        throw new Error("Invalid local history.");
      saved.ids.forEach(uint);
      return saved;
    } catch {
      return { ids: [], jobs: {} };
    }
  }
  ids(): bigint[] {
    return this.read().ids.map(uint);
  }
  restore(record: RecordJob): RecordJob {
    const entry = this.read().jobs[record.job.id.toString()];
    let binding: AgentBinding | undefined;
    let outcome: Outcome | undefined;
    try {
      if (entry?.binding) {
        assertBinding(this.profile, entry.binding, record.job.provider ?? "");
        binding = entry.binding;
      }
    } catch {
      /* A changed provider invalidates the advisory snapshot. */
    }
    const previous = entry?.outcome;
    if (
      previous &&
      terminal(record.job.state.tag) &&
      /^[a-f0-9]{64}$/.test(previous.hash) &&
      Number.isSafeInteger(previous.ledger) &&
      previous.ledger > 0 &&
      previous.method ===
        { Completed: "complete", Rejected: "reject", Expired: "claim_refund" }[
          record.job.state.tag as "Completed" | "Rejected" | "Expired"
        ]
    )
      outcome = {
        hash: previous.hash,
        ledger: previous.ledger,
        method: previous.method,
      };
    return { ...record, binding, outcome: record.outcome ?? outcome };
  }
  save(record: RecordJob): void {
    let binding: AgentBinding | undefined;
    if (record.binding) {
      assertBinding(this.profile, record.binding, record.job.provider ?? "");
      binding = record.binding;
    }
    this.writePointer(record.job.id, {
      binding,
      outcome: terminal(record.job.state.tag) ? record.outcome : undefined,
    });
  }
  private writePointer(
    id: bigint,
    pointer: { binding?: AgentBinding; outcome?: Outcome },
  ): void {
    uint(id.toString());
    const saved = this.read();
    const text = id.toString();
    saved.ids = [text, ...saved.ids.filter((value) => value !== text)].slice(
      0,
      100,
    );
    saved.jobs = Object.fromEntries(
      saved.ids.map((value) => [value, saved.jobs[value] ?? {}]),
    );
    saved.jobs[text] = pointer;
    this.storage.setItem(this.key, JSON.stringify(saved));
  }
  savePointer(
    id: bigint,
    outcome: Outcome,
    binding?: AgentBinding,
    preserveBinding = false,
  ): void {
    if (
      !outcome ||
      Object.keys(outcome).sort().join() !== "hash,ledger,method" ||
      !/^[a-f0-9]{64}$/.test(outcome.hash) ||
      !Number.isSafeInteger(outcome.ledger) ||
      outcome.ledger <= 0 ||
      ![
        "create_job",
        "set_provider",
        "set_budget",
        "fund",
        "submit",
        "complete",
        "reject",
        "claim_refund",
      ].includes(outcome.method)
    )
      throw new Error("Invalid confirmed transaction pointer.");
    if (!binding && preserveBinding)
      binding = this.read().jobs[id.toString()]?.binding;
    if (binding) assertBinding(this.profile, binding, binding.provider);
    this.writePointer(id, {
      binding,
      outcome: {
        hash: outcome.hash,
        ledger: outcome.ledger,
        method: outcome.method,
      },
    });
  }
  pending(): PendingSubmission[] {
    const text = this.storage.getItem(this.pendingKey);
    if (text === null) return [];
    if (text.length > 100_000)
      throw new Error("Pending transaction journal exceeds its size limit.");
    const saved: unknown = JSON.parse(text);
    if (!Array.isArray(saved) || saved.length > 100)
      throw new Error("Invalid pending transaction journal.");
    const seen = new Set<string>();
    return saved.map((entry: unknown) => {
      assertPendingSubmission(entry);
      if (seen.has(entry.hash))
        throw new Error("Duplicate pending transaction hash.");
      seen.add(entry.hash);
      return { ...entry };
    });
  }
  savePending(submission: PendingSubmission): void {
    assertPendingSubmission(submission);
    const saved = this.pending();
    const old = saved.find((entry) => entry.hash === submission.hash);
    if (
      old &&
      (old.method !== submission.method ||
        old.source !== submission.source ||
        old.jobId !== submission.jobId)
    )
      throw new Error("Pending transaction identity cannot change.");
    if (!old && saved.length >= 100)
      throw new Error(
        "Resolve pending transactions before adding another journal entry.",
      );
    this.storage.setItem(
      this.pendingKey,
      JSON.stringify([
        { ...submission },
        ...saved.filter((entry) => entry.hash !== submission.hash),
      ]),
    );
  }
  clearPending(hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid pending transaction hash.");
    const saved = this.pending().filter((entry) => entry.hash !== hash);
    if (saved.length)
      this.storage.setItem(this.pendingKey, JSON.stringify(saved));
    else this.storage.removeItem(this.pendingKey);
  }
  clear(): void {
    // Clearing job history must not discard unresolved signed transactions.
    this.storage.removeItem(this.key);
  }
}
