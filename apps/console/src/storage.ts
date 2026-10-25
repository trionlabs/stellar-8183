import { assertBinding } from "./identity.js";
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
  constructor(
    private storage: LocalStorage,
    private profile: Profile,
  ) {
    this.key = `8183:v1:${profile.id}:${profile.kernel}:${profile.token}`;
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
    const saved = this.read();
    const id = record.job.id.toString();
    saved.ids = [id, ...saved.ids.filter((value) => value !== id)].slice(
      0,
      100,
    );
    saved.jobs = Object.fromEntries(
      saved.ids.map((value) => [value, saved.jobs[value] ?? {}]),
    );
    let binding: AgentBinding | undefined;
    if (record.binding) {
      assertBinding(this.profile, record.binding, record.job.provider ?? "");
      binding = record.binding;
    }
    saved.jobs[id] = {
      binding,
      outcome: terminal(record.job.state.tag) ? record.outcome : undefined,
    };
    this.storage.setItem(this.key, JSON.stringify(saved));
  }
  clear(): void {
    this.storage.removeItem(this.key);
  }
}
