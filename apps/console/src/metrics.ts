type Event =
  | "session_opened"
  | "wallet_connected"
  | "job_created"
  | "job_funded"
  | "job_terminal"
  | "action_failed";
export class Metrics {
  private started = Date.now();
  private firstFundedSeconds: number | null = null;
  private events: { event: Event; elapsedSeconds: number }[] = [];
  enabled = false;
  record(event: Event): void {
    if (!this.enabled) return;
    const elapsedSeconds = Math.round((Date.now() - this.started) / 1000);
    if (event === "job_funded" && this.firstFundedSeconds === null)
      this.firstFundedSeconds = elapsedSeconds;
    this.events.push({ event, elapsedSeconds });
  }
  start(): void {
    this.enabled = true;
    this.started = Date.now();
    this.firstFundedSeconds = null;
    this.events = [];
    this.record("session_opened");
  }
  clear(): void {
    this.enabled = false;
    this.events = [];
    this.firstFundedSeconds = null;
  }
  export(mode: string): string {
    return JSON.stringify(
      {
        schema: "stellar-8183/local-metrics/v1",
        mode,
        firstFundedSeconds: this.firstFundedSeconds,
        events: this.events,
      },
      null,
      2,
    );
  }
}
