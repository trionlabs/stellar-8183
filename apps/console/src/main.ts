import { Buffer } from "buffer";
import { commitmentBytes, commitmentToHex } from "@trionlabs/stellar-8183";
import { resolveAgent } from "./identity.js";
import {
  LiveCommerce,
  ConfirmedJobReadError,
  UnconfirmedTransactionError,
  verifyOnChain,
  type ActionInput,
  type NewJob,
  type Wallet,
} from "./live.js";
import { Metrics } from "./metrics.js";
import {
  address,
  amount,
  availableActions,
  contract,
  displayAmount,
  explorer,
  terminal,
  uint,
  validateProfile,
  type Action,
  type AgentBinding,
  type Profile,
  type RecordJob,
} from "./model.js";
import { encodeReceipt, makeReceipt, parseReceipt } from "./receipt.js";
import { connectWallet } from "./wallet.js";
import { JobMemory } from "./storage.js";
import { assertBinding } from "./identity.js";
import { RecoveryJournal } from "./recovery.js";
import { VERIFIED_TESTNET_PROFILE } from "./deployment.js";
import "./style.css";

globalThis.Buffer = Buffer;
const app = document.querySelector<HTMLDivElement>("#app")!;
function initialProfile(): Profile {
  try {
    const saved = localStorage.getItem("8183:profile:v2");
    if (saved) return validateProfile(JSON.parse(saved) as Profile);
  } catch {
    /* Fall back to the bundled reviewed testnet deployment. */
  }
  return { ...VERIFIED_TESTNET_PROFILE };
}
let profile: Profile = initialProfile();
let wallet: Wallet | undefined;
let records: RecordJob[] = [];
let selected: bigint | undefined;
let filter = "all";
let busy = false;
let storageUnavailable = false;
const metrics = new Metrics();
const journals = new Map<string, RecoveryJournal>();
function recovery(): RecoveryJournal {
  const key = `${profile.id}:${profile.kernel}:${profile.token}`;
  let journal = journals.get(key);
  if (!journal) {
    let storage: Storage | undefined;
    try {
      storage = localStorage;
    } catch {
      storageUnavailable = true;
    }
    journal = new RecoveryJournal(profile, storage);
    journals.set(key, journal);
  }
  return journal;
}
const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (value: string): string =>
  `${value.slice(0, 7)}...${value.slice(-5)}`;
const actor = (): string => wallet?.address ?? "";
const clock = (): number => Math.floor(Date.now() / 1000);
const active = (): RecordJob | undefined =>
  records.find((r) => r.job.id === selected);
const live = (): LiveCommerce => {
  if (!wallet) throw new Error("Connect your Freighter wallet first.");
  return new LiveCommerce(profile, wallet);
};
const PUBLIC_READER: Wallet = {
  address: "GC2OHQG6JNXJYV36A4Q7NOUIVEUZZYPFYH747H6C3AWXQII2WCOVSFSS",
  sign: async () => {
    throw new Error("Read-only access cannot sign transactions.");
  },
};
const reader = (): LiveCommerce =>
  new LiveCommerce(profile, wallet ?? PUBLIC_READER);
const labels: Record<Action, string> = {
  set_provider: "Set provider",
  set_budget: "Set budget",
  fund: "Fund escrow",
  submit: "Submit work",
  complete: "Approve & pay",
  reject: "Reject job",
  claim_refund: "Claim expired refund",
};

function notify(message: string, error = false): void {
  const target = document.querySelector<HTMLElement>("#notice")!;
  target.textContent = message;
  target.className = `notice ${error ? "error" : "success"}`;
  target.hidden = false;
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (dialog && error) {
    let alert = dialog.querySelector<HTMLElement>(".dialog-error");
    if (!alert) {
      alert = document.createElement("p");
      alert.className = "dialog-error";
      alert.setAttribute("role", "alert");
      dialog.append(alert);
    }
    alert.textContent = message;
  }
}
async function task(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  const controls = [
    ...app.querySelectorAll<
      | HTMLButtonElement
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    >("button, input, select, textarea"),
  ].map((control) => ({ control, disabled: control.disabled }));
  controls.forEach(({ control }) => (control.disabled = true));
  try {
    await work();
  } catch (error) {
    metrics.record("action_failed");
    if (error instanceof ConfirmedJobReadError) {
      recovery().confirmed(error.jobId, error.outcome, error.binding);
      records = records.filter((record) => record.job.id !== error.jobId);
      selected = undefined;
      render();
      notify(
        `Transaction confirmed for job #${error.jobId}. Its state could not be loaded. Use Load confirmed job below; do not recreate or repeat the action.`,
      );
      const link = document.createElement("a");
      link.href = explorer(profile, "tx", error.outcome.hash);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = ` View confirmed transaction ${error.outcome.hash}`;
      document.querySelector("#notice")!.append(link);
      return;
    }
    if (error instanceof UnconfirmedTransactionError) {
      const id = error.submission.jobId;
      const previous = records.find(
        (record) => record.job.id.toString() === id,
      );
      if (previous && error.binding)
        remember({ ...previous, binding: error.binding });
      recovery().track(error.submission);
      if (id)
        records = records.filter((record) => record.job.id.toString() !== id);
      selected = undefined;
      render();
      notify(
        "A signed transaction has an unknown outcome. Use Check transaction before retrying; a network error does not prove it failed.",
        true,
      );
      return;
    }
    notify(
      error instanceof Error
        ? error.message
        : "The operation failed. Refresh the job before retrying.",
      true,
    );
  } finally {
    busy = false;
    controls.forEach(({ control, disabled }) => {
      if (control.isConnected) control.disabled = disabled;
    });
  }
}
function remember(record: RecordJob): void {
  const old = records.find((r) => r.job.id === record.job.id);
  const merged = { ...old, ...record };
  if (merged.binding) {
    try {
      assertBinding(profile, merged.binding, merged.job.provider ?? "");
    } catch {
      merged.binding = undefined;
    }
  }
  records = [merged, ...records.filter((r) => r.job.id !== record.job.id)];
  selected = record.job.id;
  recovery().observed(record.job.id);
  try {
    new JobMemory(localStorage, profile).save(merged);
  } catch {
    storageUnavailable = true;
  }
}

function restoreRecord(record: RecordJob): RecordJob {
  try {
    return new JobMemory(localStorage, profile).restore(record);
  } catch {
    storageUnavailable = true;
    return record;
  }
}
function download(name: string, content: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function row(record: RecordJob): string {
  const j = record.job;
  return `<button class="job-row ${selected === j.id ? "selected" : ""}" data-job="${j.id}"><span class="job-number">${j.id.toString().padStart(2, "0")}</span><span class="job-description"><strong>${esc(j.desc)}</strong><small>${esc(j.provider ? short(j.provider) : "Provider unassigned")} <span class="separator">/</span> ${esc(displayAmount(j.budget, profile.decimals))} ${esc(profile.symbol)}</small></span><span class="badge ${j.state.tag.toLowerCase()}">${j.state.tag}</span><span class="arrow">&nearr;</span></button>`;
}
function lifecycleProgress(state: RecordJob["job"]["state"]["tag"]): string {
  if (terminal(state))
    return `<p class="hint terminal-outcome">Final outcome: ${state}</p>`;
  const position = ["Open", "Funded", "Submitted"].indexOf(state);
  return `<div class="progress" aria-label="Job lifecycle">${["Open", "Funded", "Submitted", "Settled"].map((label, index) => `<span class="${position >= index ? "done" : ""}">${index + 1}. ${label}</span>`).join("")}</div>`;
}
function recoveryPanel(): HTMLElement | undefined {
  const journal = recovery();
  const pending = journal.pending();
  const missing = journal.missing(records.map((record) => record.job.id));
  if (!pending.length && !missing.length) return;
  const panel = document.createElement("section");
  panel.className = "recovery-panel";
  panel.setAttribute("aria-label", "Transaction recovery");
  panel.innerHTML = `<h2>Recover a transaction or job</h2><p>Signed transactions are never retried automatically. An unavailable response does not prove a transaction failed.</p>${pending.map((item) => `<article><span>${item.method === "create_job" ? "Create job" : esc(labels[item.method])}${item.jobId ? ` - job #${esc(item.jobId)}` : ""}</span><a href="${explorer(profile, "tx", item.hash)}" target="_blank" rel="noopener noreferrer"><code>${esc(item.hash)}</code></a><button class="secondary" data-check-submission="${item.hash}">Check transaction</button></article>`).join("")}${missing.map((id) => `<article><span>Saved job #${id}: current state unavailable</span><button class="secondary" data-recover-job="${id}">Load confirmed job #${id}</button></article>`).join("")}${journal.storageUnavailable ? `<p class="hint">Browser storage is unavailable. Tracking is in memory only; save these public IDs and transaction hashes before leaving.</p>` : ""}`;
  return panel;
}
async function checkSubmission(hash: string): Promise<void> {
  const journal = recovery();
  const pending = journal.pending().find((item) => item.hash === hash);
  if (!pending) return;
  const result = await reader().recoverSubmission(pending);
  if (result.status === "unknown") {
    notify(
      "This transaction is still unavailable from RPC. Its outcome remains unknown. Check Stellar Expert or try the status check later; do not resend automatically.",
      true,
    );
    return;
  }
  journal.clear(hash);
  if (result.status === "failed") {
    render();
    notify(
      "The tracked transaction failed on-chain. Review the job's current state before preparing a new action.",
      true,
    );
    return;
  }
  remember(restoreRecord(result.record));
  render();
  notify(
    `Confirmed transaction recovered. Job #${result.record.job.id} is ${result.record.job.state.tag}.`,
  );
}
async function stopTracking(hash: string): Promise<void> {
  const journal = recovery();
  const pending = journal.pending().find((item) => item.hash === hash);
  if (!pending) return;
  const dialog = modal(
    "Stop local transaction tracking",
    `<p>This only removes a local reminder. It does not cancel the transaction or prove it failed. It may already have applied or may apply later. Check this hash in your wallet or Stellar Expert first; retrying a successful creation can create another job.</p><code>${esc(hash)}</code><p>A public reference will be downloaded so you can check the outcome later.</p><button class="primary full" id="stop-tracking">Save reference and stop tracking</button>`,
  );
  const accepted = await new Promise<boolean>((resolve) => {
    dialog.addEventListener("close", () => resolve(false), { once: true });
    dialog.querySelector("#stop-tracking")!.addEventListener(
      "click",
      () => {
        resolve(true);
        dialog.close();
      },
      { once: true },
    );
  });
  if (!accepted) return;
  download(
    `8183-pending-${hash}.json`,
    JSON.stringify(
      {
        schema: "stellar-8183/pending-reference/v1",
        network: profile.id,
        kernel: profile.kernel,
        token: profile.token,
        submission: pending,
        status: "unverified-reference",
      },
      null,
      2,
    ),
  );
  journal.clear(hash);
  render();
  notify(
    `Local tracking cleared for ${hash}. This did not cancel the transaction or verify its outcome. Keep the downloaded reference.`,
    true,
  );
}
function detail(): string {
  const record = active();
  if (!record)
    return `<div class="empty-detail"><span class="empty-mark">[ ]</span><h3>A clear path to settlement.</h3><p>Select a job to view its terms, review the work, or take the next step.</p></div>`;
  const j = record.job,
    state = j.state.tag;
  if (recovery().blocksJob(j.id))
    return `<h2>Job #${j.id}: transaction outcome unknown</h2><p class="hint">Check the tracked transaction above before taking another action. The previous screen is not proof that a signed transaction failed.</p>`;
  const actions = availableActions(j, actor(), clock());
  const expiry = new Date(Number(j.expires_at) * 1000).toLocaleString();
  const expired = BigInt(clock()) >= j.expires_at;
  return `<div class="detail-head"><span class="eyebrow">JOB ${j.id}</span><span class="badge ${state.toLowerCase()}">${state}</span></div><h2>${esc(j.desc)}</h2><div class="budget"><span>${esc(displayAmount(j.budget, profile.decimals))}</span> ${esc(profile.symbol)}</div>${lifecycleProgress(state)}<dl class="terms"><dt>Client</dt><dd title="${j.client}">${esc(short(j.client))}${actor() === j.client ? " (you)" : ""}</dd><dt>Provider</dt><dd title="${esc(j.provider)}">${j.provider ? esc(short(j.provider)) : "Unassigned"}${actor() === j.provider ? " (you)" : ""}</dd><dt>Evaluator</dt><dd title="${j.evaluator}">${esc(short(j.evaluator))}${actor() === j.evaluator ? " (you)" : ""}</dd><dt>Expiry</dt><dd>${esc(expiry)}${expired ? " (passed)" : ""}</dd><dt>Policy hook</dt><dd>${j.hook ? esc(short(j.hook)) : "None"}</dd></dl>${record.binding ? `<p class="hint">Imported agent ${esc(record.binding.agentId)}. Wallet observed at ledger ${record.binding.resolvedAtLedger}. This is a client snapshot.</p>` : ""}${j.work_hash ? `<div class="commitment"><span class="eyebrow">WORK SHA-256</span><code>${esc(commitmentToHex(j.work_hash))}</code></div>` : ""}${actions.length ? `<form id="action-form"><label>Next step<select name="action" id="action">${actions.map((a) => `<option value="${a}">${labels[a]}</option>`).join("")}</select></label><div id="action-inputs"></div><button class="primary full" type="submit">Review action <span>&rarr;</span></button></form>` : `<p class="hint">${terminal(state) ? "This job is settled. No further payment can be released." : "The next action belongs to a different wallet. Refresh the job after they act."}</p>`}${!terminal(state) && expired ? `<p class="hint">After expiry, a valid decision and refund can race. The first successful transaction wins.</p>` : ""}${record.outcome ? `<a class="text-link" href="${explorer(profile, "tx", record.outcome.hash)}" target="_blank" rel="noopener noreferrer">View latest transaction &nearr;</a>` : ""}${terminal(state) ? `<button class="secondary full" data-click="receipt">Download outcome receipt</button>` : ""}<button class="text-button" data-click="refresh">Refresh job</button>`;
}

function render(): void {
  const visible = records.filter(
    (record) =>
      filter === "all" ||
      (filter === "active"
        ? !terminal(record.job.state.tag)
        : terminal(record.job.state.tag)),
  );
  const escrow = records
    .filter((record) => ["Funded", "Submitted"].includes(record.job.state.tag))
    .reduce((sum, record) => sum + record.job.budget, 0n);
  const activeJobs = records.filter(
    (record) => !terminal(record.job.state.tag),
  ).length;
  const settledJobs = records.length - activeJobs;
  const networkName =
    profile.id === "testnet" ? "Stellar Testnet" : "Stellar Mainnet";

  app.innerHTML = `
    <header class="sidebar">
      <a class="brand" href="/" aria-label="8183 home">
        <span class="brand-mark">8</span>
        <b>8183<span>AGENT COMMERCE</span></b>
      </a>
      <button class="nav-item current" data-click="jobs">Jobs</button>
      <button class="nav-item" data-click="verify">Verify receipt</button>
      <button class="nav-item" data-click="settings">Network settings</button>
      <div class="wallet-area">
        <span class="network-dot"></span>
        <span>${esc(profile.id === "testnet" ? "TESTNET" : "MAINNET")}</span>
        <button class="wallet-button" data-click="connect">${wallet ? esc(short(wallet.address)) : "Connect wallet"}</button>
      </div>
    </header>
    <div class="workspace">
      <main>
        <section class="page-title">
          <div>
            <span class="eyebrow">STELLAR 8183 / ${esc(profile.id.toUpperCase())}</span>
            <h1>Fund work. Settle on-chain.</h1>
            <p>Escrow for digital work, settled by an evaluator on Stellar.</p>
          </div>
          ${wallet ? '<button class="primary" data-click="new">+ Create job</button>' : ""}
        </section>
        <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
        ${
          wallet
            ? ""
            : `<section class="connect-gate"><div><span class="eyebrow">START HERE</span><h2>Connect Freighter to use the ${profile.id === "testnet" ? "verified testnet" : "configured mainnet"} deployment.</h2><p>Transactions are submitted to Stellar and require wallet approval.</p></div><button class="primary" data-click="connect">Connect Freighter</button></section>`
        }
        <div class="live-banner"><strong>${networkName}</strong><span>${esc(profile.symbol)}</span><a href="${explorer(profile, "contract", profile.kernel)}" target="_blank" rel="noopener noreferrer">view contract</a><span>${profile.id === "mainnet-canary" ? "valueless canary only" : "test assets have no monetary value"}</span></div>
        <section class="stats" aria-label="Workspace metrics">
          <article><span>IN ESCROW</span><strong>${esc(displayAmount(escrow, profile.decimals))} <small>${esc(profile.symbol)}</small></strong><p>Across jobs loaded here</p></article>
          <article><span>ACTIVE</span><strong>${activeJobs.toString().padStart(2, "0")}</strong><p>Open, funded, or submitted</p></article>
          <article><span>SETTLED</span><strong>${settledJobs.toString().padStart(2, "0")}</strong><p>Completed, rejected, or expired</p></article>
        </section>
        <div class="content-grid">
          <section class="jobs-panel">
            <div class="panel-heading"><h2>Loaded jobs <span>${records.length}</span></h2><button class="text-button" data-click="load">Load by ID &nearr;</button></div>
            <div class="tabs" role="group" aria-label="Job filters">${["all", "active", "settled"].map((item) => `<button data-filter="${item}" class="${filter === item ? "active" : ""}">${item === "all" ? "All" : item[0]!.toUpperCase() + item.slice(1)}</button>`).join("")}</div>
            <div class="job-list">${visible.length ? visible.map(row).join("") : `<div class="empty-list"><h3>No jobs loaded.</h3><p>Connect your wallet to create a job, or load a public job by ID.</p><button class="secondary" data-click="load">Load a job</button></div>`}</div>
            <div class="panel-footer">ON-CHAIN RECORDS ONLY<span>Client &rarr; Provider &rarr; Evaluator</span></div>
          </section>
          <section class="detail-panel" aria-label="Selected job">${detail()}</section>
        </div>
        <footer class="page-footer"><span>The evaluator decides quality. The contract enforces payment and expiry.</span><button class="text-button" data-click="metrics">${metrics.enabled ? "Export session metrics" : "Enable local session metrics"}</button></footer>
      </main>
    </div>
    <dialog id="modal"><div id="modal-content"></div></dialog>`;

  const recoveryView = recoveryPanel();
  if (recoveryView) {
    app.querySelector(".stats")!.before(recoveryView);
    recovery()
      .pending()
      .forEach((item) => {
        const recoveryRow = recoveryView.querySelector(
          `[data-check-submission="${item.hash}"]`,
        )?.parentElement;
        if (!recoveryRow) return;
        const button = document.createElement("button");
        button.className = "text-button";
        button.textContent = "Stop local tracking";
        button.addEventListener(
          "click",
          () => void task(() => stopTracking(item.hash)),
        );
        recoveryRow.append(button);
      });
  }
  bind();
  actionInputs();
}

function modal(title: string, body: string): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.id = "modal";
  document.querySelector("#modal")!.replaceWith(dialog);
  dialog.innerHTML = `<div class="modal-heading"><h2>${esc(title)}</h2><button class="close" data-close aria-label="Close dialog">&times;</button></div>${body}`;
  dialog
    .querySelector("[data-close]")!
    .addEventListener("click", () => dialog.close());
  dialog.showModal();
  return dialog;
}
async function review(title: string, details: string): Promise<boolean> {
  const dialog = modal(
    title,
    `<p class="review-terms">${esc(details)}</p><p class="hint">Network: ${esc(profile.id)}. Maximum fee: ${Number(profile.maxFee) / 1e7} XLM. You will approve the exact transaction in Freighter.</p><button class="primary full" id="confirm-action">Continue to wallet</button>`,
  );
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(false), { once: true });
    dialog.querySelector("#confirm-action")!.addEventListener(
      "click",
      () => {
        resolve(true);
        dialog.close();
      },
      { once: true },
    );
  });
}

function newJob(): void {
  if (!wallet) {
    notify("Connect your Freighter wallet before creating a job.", true);
    return;
  }
  if (recovery().blocksCreate(actor())) {
    notify(
      "A job creation from this wallet has an unknown outcome. Check its tracked transaction before creating another job.",
      true,
    );
    return;
  }
  const dialog = modal(
    "Commission a new job",
    `<form id="create-form"><p class="hint">Descriptions are public on-chain. Agree the evaluator and deadline before funding.</p><label>What needs to be delivered?<textarea name="description" required maxlength="512" placeholder="e.g. Translate the product brief into Spanish"></textarea></label><label>Provider address (optional until funding)<input name="provider" placeholder="G... or C..." /></label><label>Evaluator address<input name="evaluator" required value="${actor()}" /></label><p class="hint">The evaluator can approve or reject work. It may be the client; it is a trusted role, not independent arbitration.</p><div class="form-row"><label>Expiry in minutes<input name="minutes" type="number" min="1" max="43200" required value="60" /></label><label>SLA hook (optional)<input name="hook" placeholder="C..." /></label></div><button class="primary full">Review new job &rarr;</button></form>`,
  );
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    void task(async () => {
      const minutes = Number(data.get("minutes"));
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200)
        throw new Error("Expiry must be between 1 minute and 30 days.");
      const input: NewJob = {
        description: String(data.get("description")).trim(),
        provider: data.get("provider")
          ? address(String(data.get("provider")).trim())
          : undefined,
        evaluator: address(String(data.get("evaluator")).trim()),
        expiresAt: BigInt(clock() + minutes * 60),
        hook: data.get("hook")
          ? contract(String(data.get("hook")).trim())
          : undefined,
      };
      dialog.close();
      if (
        !(await review(
          "Review new job",
          `${input.description}\nProvider: ${input.provider ?? "unassigned"}\nEvaluator: ${input.evaluator}\nExpiry: ${new Date(Number(input.expiresAt) * 1000).toLocaleString()}\nNo funds move until you set a budget and fund escrow.`,
        ))
      )
        return;
      if (recovery().blocksCreate(actor()))
        throw new Error(
          "Check the tracked creation transaction before creating another job.",
        );
      remember(await live().create(input));
      metrics.record("job_created");
      render();
      notify(
        "Job created. Set a budget, confirm the provider, then fund escrow.",
      );
    });
  });
}
function actionInputs(): void {
  const action = document.querySelector<HTMLSelectElement>("#action")?.value as
    Action | undefined;
  const target = document.querySelector("#action-inputs");
  if (!target || !action) return;
  const record = active()!;
  target.innerHTML =
    action === "set_budget"
      ? `<label>Budget (${esc(profile.symbol)})<input name="budget" required inputmode="decimal" value="${record.job.budget ? displayAmount(record.job.budget, profile.decimals) : "1"}" /></label>`
      : action === "set_provider"
        ? `<label>Provider address<input name="provider" required value="${esc(record.job.provider)}" /></label>`
        : ["submit", "complete", "reject"].includes(action)
          ? `<label>${action === "submit" ? "Work SHA-256 (required)" : "Decision SHA-256 (optional)"}<input name="commitment" pattern="[a-fA-F0-9]{64}" ${action === "submit" ? "required" : ""} placeholder="64 hexadecimal characters" /></label><label class="file-label">Hash a deliverable file locally<input type="file" id="hash-file" /></label><p class="hint">Only the hash is committed. Deliver the file to the client separately.</p>`
          : action === "fund"
            ? `<p class="hint">This locks ${esc(displayAmount(record.job.budget, profile.decimals))} ${esc(profile.symbol)}. Verify the provider, evaluator, expiry, and any policy hook. ${record.binding ? "The agent wallet will be resolved again before signing." : "Direct provider address; no identity lookup required."}</p>`
            : `<p class="hint">Return expired escrow to the recorded client. Anyone can trigger this refund.</p>`;
  document
    .querySelector<HTMLInputElement>("#hash-file")
    ?.addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file)
        void task(async () => {
          if (file.size > 25_000_000)
            throw new Error("Choose a file smaller than 25 MB.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          (
            target.querySelector("[name=commitment]") as HTMLInputElement
          ).value = commitmentToHex(commitmentBytes(bytes));
          notify("File hashed locally. Its contents were not uploaded.");
        });
    });
}

function settings(): void {
  const dialog = modal(
    "Choose a network",
    `<div class="network-options">
      <section class="network-option">
        <span class="eyebrow">READY TO USE</span>
        <h3>Stellar Testnet</h3>
        <p>The verified 8183 deployment and DEMO8183 test asset. Test assets have no monetary value.</p>
        <button class="primary full" data-network="testnet">Use verified Testnet</button>
      </section>
      <section class="network-option">
        <span class="eyebrow">REVIEWED CANARY ONLY</span>
        <h3>Stellar Mainnet</h3>
        <p>Import an approved, valueless DEMO8183 canary profile. Valuable assets and unreviewed deployments are rejected.</p>
        <form id="mainnet-profile-form">
          <label>Reviewed profile JSON<input name="profile" type="file" accept="application/json,.json" required /></label>
          <p id="profile-summary" class="hint" role="status">No Mainnet profile selected.</p>
          <button class="secondary full" disabled>Use imported Mainnet canary</button>
        </form>
      </section>
    </div>
    <p class="hint">Changing networks clears loaded jobs and disconnects the wallet. It never moves funds.</p>`,
  );
  const useProfile = (next: Profile): void => {
    profile = validateProfile(next);
    metrics.clear();
    try {
      localStorage.setItem("8183:profile:v2", JSON.stringify(profile));
    } catch {
      storageUnavailable = true;
    }
    records = [];
    selected = undefined;
    wallet = undefined;
    dialog.close();
    render();
    notify(
      `${profile.id === "testnet" ? "Testnet" : "Mainnet canary"} selected. Connect the matching Freighter wallet to sign transactions.`,
    );
  };
  dialog
    .querySelector<HTMLButtonElement>('[data-network="testnet"]')!
    .addEventListener("click", () =>
      useProfile({ ...VERIFIED_TESTNET_PROFILE }),
    );

  let imported: Profile | undefined;
  const form = dialog.querySelector<HTMLFormElement>("#mainnet-profile-form")!;
  const file = form.elements.namedItem("profile") as HTMLInputElement;
  const summary = form.querySelector<HTMLElement>("#profile-summary")!;
  const submit = form.querySelector<HTMLButtonElement>(
    'button[type="submit"], button:not([type])',
  )!;
  let importAttempt = 0;
  file.addEventListener("change", () => {
    const attempt = ++importAttempt;
    imported = undefined;
    submit.disabled = true;
    const selectedFile = file.files?.[0];
    if (!selectedFile) return;
    void (async () => {
      try {
        if (selectedFile.size > 8000)
          throw new Error("Deployment profile is too large.");
        const next = validateProfile(
          JSON.parse(await selectedFile.text()) as Profile,
        );
        if (next.id !== "mainnet-canary")
          throw new Error("Import an approved Mainnet canary profile.");
        if (attempt !== importAttempt) return;
        imported = next;
        summary.textContent = `${next.symbol} / kernel ${short(next.kernel)} / token ${short(next.token)}`;
        submit.disabled = false;
        dialog.querySelector(".dialog-error")?.remove();
      } catch (error) {
        if (attempt !== importAttempt) return;
        notify(
          error instanceof Error
            ? error.message
            : "Invalid deployment profile.",
          true,
        );
      }
    })();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!imported) throw new Error("Select a valid Mainnet canary profile.");
    useProfile(imported);
  });
}

async function doAction(data: FormData): Promise<void> {
  const record = active();
  if (!record) return;
  if (recovery().blocksJob(record.job.id))
    throw new Error(
      "Check the tracked transaction before repeating an action for this job.",
    );
  const action = String(data.get("action")) as Action;
  const input: ActionInput = {
    provider: data.get("provider")
      ? String(data.get("provider")).trim()
      : undefined,
    budget: data.get("budget")
      ? amount(String(data.get("budget")), profile.decimals)
      : undefined,
    commitment: data.get("commitment")
      ? String(data.get("commitment")).toLowerCase()
      : undefined,
  };
  if (
    !(await review(
      labels[action],
      `Job #${record.job.id}: ${record.job.desc}\nWallet: ${actor()}\nBudget: ${displayAmount(input.budget ?? record.job.budget, profile.decimals)} ${profile.symbol}\nProvider: ${input.provider ?? record.job.provider ?? "unassigned"}\nEvaluator: ${record.job.evaluator}\nExpiry: ${new Date(Number(record.job.expires_at) * 1000).toLocaleString()}`,
    ))
  )
    return;
  if (recovery().blocksJob(record.job.id))
    throw new Error(
      "Check the tracked transaction before repeating an action for this job.",
    );
  const next = await live().act(
    record.job.id,
    action,
    input,
    record.binding,
    record.job,
  );
  remember(next);
  if (action === "fund") metrics.record("job_funded");
  if (terminal(next.job.state.tag)) metrics.record("job_terminal");
  render();
  notify(`${labels[action]} confirmed. Job is ${next.job.state.tag}.`);
}

function loadJob(): void {
  const dialog = modal(
    "Load a job",
    `<form><label>Job ID<input name="jobId" required inputmode="numeric" placeholder="e.g. 4" /></label><button class="primary full">Load job</button></form>`,
  );
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    void task(async () => {
      const id = uint(String(data.get("jobId")));
      remember(restoreRecord({ job: await reader().read(id) }));
      dialog.close();
      render();
    });
  });
}
function importIdentity(): void {
  const record = active();
  if (!record || record.job.state.tag !== "Open") {
    notify("Select an Open job to import a provider.", true);
    return;
  }
  if (recovery().blocksJob(record.job.id)) {
    notify(
      "Check the tracked transaction before changing this job's provider.",
      true,
    );
    return;
  }
  const dialog = modal(
    "Import an 8004 provider",
    `<form><p class="hint">Reads the Stellar 8004 v0.1 get_agent_wallet(u32) profile. Identity is not proof of work quality. You will review and sign a separate set-provider action.</p><label>Identity Registry contract<input name="registry" required placeholder="C..." /></label><label>Agent ID<input name="agentId" required inputmode="numeric" /></label><button class="primary full">Resolve wallet</button></form>`,
  );
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    void task(async () => {
      const binding: AgentBinding = await resolveAgent(
        profile,
        {
          network: profile.id,
          identityRegistry: String(data.get("registry")).trim(),
          agentId: String(data.get("agentId")).trim(),
        },
        actor(),
      );
      dialog.close();
      if (
        !(await review(
          "Use this agent wallet?",
          `Registry: ${binding.identityRegistry}\nAgent: ${binding.agentId}\nProvider: ${binding.provider}\nObserved ledger: ${binding.resolvedAtLedger}`,
        ))
      )
        return;
      if (recovery().blocksJob(record.job.id))
        throw new Error(
          "Check the tracked transaction before changing this job's provider.",
        );
      const next = await live().act(record.job.id, "set_provider", {
        provider: binding.provider,
      });
      remember({ ...next, binding });
      render();
      notify(
        "Provider assigned. Identity will be resolved once more before funding.",
      );
    });
  });
}
function verifyDialog(): void {
  const dialog = modal(
    "Verify an outcome receipt",
    `<form><p class="hint">The content hash detects file changes. Live verification also checks the terminal job and transaction against the selected deployment. It does not certify work quality or historical 8004 ownership.</p><label>Receipt JSON<textarea name="receipt" required rows="8" placeholder="Paste the exported JSON"></textarea></label><button class="primary full">Verify receipt</button><p id="verification" role="status"></p></form>`,
  );
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = String(
      new FormData(event.target as HTMLFormElement).get("receipt"),
    );
    void task(async () => {
      const file = await parseReceipt(text);
      const message = await verifyOnChain(file, profile, reader());
      dialog.querySelector("#verification")!.textContent = message;
    });
  });
}

async function exportRecordReceipt(record: RecordJob): Promise<void> {
  if (!record.outcome) throw new Error("A terminal transaction is required.");
  const file = await makeReceipt(
    profile,
    record.job,
    record.outcome,
    record.binding,
  );
  await verifyOnChain(file, profile, reader());
  download(`8183-${profile.id}-${record.job.id}.json`, encodeReceipt(file));
  notify("Outcome receipt downloaded. Use Verify receipt to inspect it.");
}

function recoverReceipt(record: RecordJob): void {
  const dialog = modal(
    "Recover a settled job receipt",
    `<form><p class="hint">Paste the terminal transaction hash from Stellar Expert. The Console checks the successful transaction and immutable job before exporting.</p><label>Terminal transaction hash<input name="hash" required pattern="[a-f0-9]{64}" placeholder="64 hexadecimal characters" /></label><button class="primary full">Verify and download</button></form>`,
  );
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.target as HTMLFormElement);
    void task(async () => {
      const hash = String(data.get("hash"));
      const response = await reader().server.getTransaction(hash);
      if (response.status !== "SUCCESS")
        throw new Error(
          "Transaction is not available as a successful RPC result. Capture evidence promptly; RPC retention is limited.",
        );
      const method = {
        Completed: "complete",
        Rejected: "reject",
        Expired: "claim_refund",
      }[record.job.state.tag as "Completed" | "Rejected" | "Expired"];
      const next = {
        ...record,
        outcome: { hash, ledger: response.ledger, method },
      };
      await exportRecordReceipt(next);
      remember(next);
      dialog.close();
      render();
      notify("Verified terminal receipt recovered and downloaded.");
    });
  });
}
async function clicks(name: string): Promise<void> {
  switch (name) {
    case "new":
      newJob();
      break;
    case "jobs":
      filter = "all";
      render();
      break;
    case "settings":
      settings();
      break;
    case "connect":
      {
        const connected = await connectWallet(profile);
        await new LiveCommerce(profile, connected).tokenInfo();
        wallet = connected;
        try {
          for (const id of new JobMemory(localStorage, profile)
            .ids()
            .slice(0, 20)) {
            try {
              remember(restoreRecord({ job: await reader().read(id) }));
            } catch {
              /* An unavailable job can be retried by ID. */
            }
          }
        } catch {
          storageUnavailable = true;
        }
        metrics.record("wallet_connected");
        render();
        notify("Wallet connected and payment token verified.");
      }
      break;
    case "refresh":
      if (selected !== undefined) {
        const previous = active();
        remember({ ...previous, job: await reader().read(selected) });
        render();
      }
      break;
    case "load":
      loadJob();
      break;
    case "identity":
      importIdentity();
      break;
    case "discard-identity": {
      const record = active();
      if (record) {
        if (recovery().blocksJob(record.job.id))
          throw new Error(
            "Check the tracked transaction before changing its identity snapshot.",
          );
        remember({ ...record, binding: undefined });
        render();
        notify(
          "Using the recorded provider address directly. No 8004 identity claim will be attached to funding or the receipt.",
        );
      }
      break;
    }
    case "verify":
      verifyDialog();
      break;
    case "receipt": {
      const record = active();
      if (!record) return;
      if (
        !record.outcome ||
        !terminal(record.job.state.tag) ||
        !["complete", "reject", "claim_refund"].includes(record.outcome.method)
      ) {
        if (terminal(record.job.state.tag)) recoverReceipt(record);
        else throw new Error("Select a terminal job with settlement evidence.");
        break;
      }
      await exportRecordReceipt(record);
      break;
    }
    case "metrics":
      if (metrics.enabled)
        download(`8183-${profile.id}-metrics.json`, metrics.export(profile.id));
      else {
        metrics.start();
        render();
        notify(
          "Local metrics enabled for this session. No data leaves your browser; export when ready.",
        );
      }
      break;
  }
}
function bind(): void {
  app.querySelector<HTMLAnchorElement>(".brand")!.href =
    import.meta.env.BASE_URL;
  app
    .querySelectorAll<HTMLButtonElement>("[data-check-submission]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () => void task(() => checkSubmission(button.dataset.checkSubmission!)),
      ),
    );
  app
    .querySelectorAll<HTMLButtonElement>("[data-recover-job]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () =>
          void task(async () => {
            const id = uint(button.dataset.recoverJob!);
            remember(restoreRecord({ job: await reader().read(id) }));
            render();
            notify(`Job #${id} loaded from the confirmed public record.`);
          }),
      ),
    );
  app
    .querySelectorAll<HTMLButtonElement>("[data-click]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () => void task(() => clicks(button.dataset.click!)),
      ),
    );
  app.querySelectorAll<HTMLButtonElement>("[data-job]").forEach((button) =>
    button.addEventListener("click", () => {
      if (busy) return;
      selected = BigInt(button.dataset.job!);
      render();
    }),
  );
  app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      filter = button.dataset.filter!;
      render();
    }),
  );
  document.querySelector("#action")?.addEventListener("change", actionInputs);
  document
    .querySelector("#action-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      void task(() => doAction(data));
    });
  if (
    active()?.job.state.tag === "Open" &&
    !recovery().blocksJob(active()!.job.id)
  ) {
    const button = document.createElement("button");
    button.className = "text-button";
    button.textContent = "Import provider from 8004";
    button.addEventListener(
      "click",
      () => void task(async () => importIdentity()),
    );
    document.querySelector(".detail-panel")!.append(button);
    if (active()?.binding) {
      const direct = document.createElement("button");
      direct.className = "text-button";
      direct.textContent = "Use provider address without 8004";
      direct.addEventListener(
        "click",
        () => void task(() => clicks("discard-identity")),
      );
      document.querySelector(".detail-panel")!.append(direct);
    }
  }
  if (storageUnavailable)
    notify(
      "Browser storage is unavailable. Keep the job ID and download receipts before leaving this session.",
      true,
    );
}

render();
