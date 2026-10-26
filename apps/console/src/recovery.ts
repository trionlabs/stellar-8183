import type { PendingSubmission } from "./live.js";
import type { AgentBinding, Outcome, Profile } from "./model.js";
import { JobMemory, type LocalStorage } from "./storage.js";

// Failed persistence must not turn an uncertain signed action into a safe retry.
export class RecoveryJournal {
  private memory?: JobMemory;
  private uncertain = new Map<string, PendingSubmission>();
  private cleared = new Set<string>();
  private known = new Set<bigint>();
  storageUnavailable = false;

  constructor(profile: Profile, storage?: LocalStorage) {
    if (storage) this.memory = new JobMemory(storage, profile);
    else this.storageUnavailable = true;
  }
  private read<T>(work: (memory: JobMemory) => T, fallback: T): T {
    try {
      if (!this.memory) return fallback;
      return work(this.memory);
    } catch {
      this.storageUnavailable = true;
      return fallback;
    }
  }
  private write(work: (memory: JobMemory) => void): void {
    this.read(work, undefined);
  }
  pending(): PendingSubmission[] {
    const saved = this.read((memory) => memory.pending(), []);
    return [
      ...new Map(
        [...saved, ...this.uncertain.values()].map((item) => [item.hash, item]),
      ).values(),
    ].filter((item) => !this.cleared.has(item.hash));
  }
  track(submission: PendingSubmission): void {
    this.cleared.delete(submission.hash);
    this.uncertain.set(submission.hash, submission);
    this.write((memory) => memory.savePending(submission));
  }
  clear(hash: string): void {
    this.uncertain.delete(hash);
    this.cleared.add(hash);
    this.write((memory) => memory.clearPending(hash));
  }
  confirmed(id: bigint, outcome: Outcome, binding?: AgentBinding): void {
    this.known.add(id);
    this.write((memory) =>
      memory.savePointer(
        id,
        outcome,
        binding,
        outcome.method !== "set_provider",
      ),
    );
    this.clear(outcome.hash);
  }
  observed(id: bigint): void {
    this.known.delete(id);
  }
  missing(loaded: bigint[]): bigint[] {
    const ids = [
      ...new Set([...this.read((memory) => memory.ids(), []), ...this.known]),
    ];
    const pending = new Set(this.pending().map((item) => item.jobId));
    return ids.filter(
      (id) => !loaded.includes(id) && !pending.has(id.toString()),
    );
  }
  blocksCreate(source: string): boolean {
    return this.pending().some(
      (item) => item.method === "create_job" && item.source === source,
    );
  }
  blocksJob(id: bigint): boolean {
    return this.pending().some((item) => item.jobId === id.toString());
  }
}
