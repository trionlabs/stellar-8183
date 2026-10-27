import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { inspectInvocation } from "@trionlabs/stellar-8183";
import { defaultIdentityRegistry } from "../src/identity.js";
import { LiveCommerce } from "../src/live.js";
import { parseReceipt, type ReceiptFile } from "../src/receipt.js";
import { validateProfile, type Profile } from "../src/model.js";

interface Request {
  type: string;
  transactionXdr?: string;
  networkPassphrase?: string;
  accountToSign?: string;
}
declare global {
  interface Window {
    __8183TestWalletRequest(request: Request): Promise<Record<string, unknown>>;
  }
}
const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
type Role = "client" | "provider" | "evaluator";

test("author-run live browser settlement through Freighter's message protocol", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_LIVE_TESTNET !== "1",
    "Explicit testnet signing opt-in required; never uses mainnet or participant keys.",
  );
  const sourceCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  const inputs = [
    "apps/console",
    "packages/sdk",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
  ];
  try {
    await execute("git", ["diff", "--exit-code", "HEAD", "--", ...inputs], {
      cwd: root,
    });
    const untracked = await execute(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", ...inputs],
      { cwd: root },
    );
    if (untracked.stdout.trim()) throw new Error("Untracked input");
  } catch {
    throw new Error(
      "Commit the reviewed application inputs before recording a source-bound live test.",
    );
  }
  const files = [
    "index.html",
    "mark.svg",
    "testnet-profile.json",
    ...(await readdir(resolve(root, "apps/console/dist/assets"))).map(
      (name) => `assets/${name}`,
    ),
  ];
  const applicationFiles: Record<string, string> = {};
  for (const name of files)
    applicationFiles[name] = createHash("sha256")
      .update(await readFile(resolve(root, "apps/console/dist", name)))
      .digest("hex");
  if (process.env.CONSOLE_LIVE_URL) {
    const base = new URL(process.env.CONSOLE_LIVE_URL);
    const metadata = (await (
      await fetch(new URL("build.json", base))
    ).json()) as { sourceCommit?: string };
    expect(metadata.sourceCommit).toBe(sourceCommit);
    for (const [name, expectedHash] of Object.entries(applicationFiles)) {
      const response = await fetch(new URL(name, base));
      expect(response.ok).toBe(true);
      expect(
        createHash("sha256")
          .update(Buffer.from(await response.arrayBuffer()))
          .digest("hex"),
      ).toBe(expectedHash);
    }
  }
  const profile = validateProfile(
    JSON.parse(
      await readFile(
        resolve(root, "apps/console/public/testnet-profile.json"),
        "utf8",
      ),
    ) as Profile,
  );
  if (
    profile.id !== "testnet" ||
    profile.networkPassphrase !== Networks.TESTNET
  )
    throw new Error("Live browser test is testnet-only.");
  const keys = {} as Record<Role, Keypair>;
  for (const role of ["client", "provider", "evaluator"] as const) {
    try {
      const { stdout } = await execute("stellar", [
        "keys",
        "show",
        `m2-${role}`,
        "--config-dir",
        resolve(root, ".stellar/month-two"),
      ]);
      keys[role] = Keypair.fromSecret(stdout.trim());
    } catch {
      throw new Error(
        `Dedicated testnet ${role} signer unavailable. No secret output is retained.`,
      );
    }
  }
  let role: Role = "client";
  let network: string = Networks.TESTNET;
  let approval: "accept" | "decline" | "switch-account" = "accept";
  let submissions = 0;
  let dropConfirmation = true;
  let failRecoveryRead = false;
  await page.route(new URL(profile.rpcUrl).href, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const request = route.request().postDataJSON() as {
      method?: string;
      params?: { transaction?: string };
    };
    if (request.method === "getTransaction" && dropConfirmation) {
      dropConfirmation = false;
      await route.abort("failed");
      return;
    }
    if (
      request.method === "simulateTransaction" &&
      failRecoveryRead &&
      request.params?.transaction
    ) {
      const envelope = TransactionBuilder.fromXDR(
        request.params.transaction,
        Networks.TESTNET,
      );
      if (
        envelope instanceof Transaction &&
        inspectInvocation(envelope).method === "get_job"
      ) {
        failRecoveryRead = false;
        await route.abort("failed");
        return;
      }
    }
    await route.continue();
  });
  const signedMethods: string[] = [];
  page.on("request", (request) => {
    if (
      request.url() === new URL(profile.rpcUrl).href &&
      request.method() === "POST"
    ) {
      const json = request.postDataJSON() as { method?: string } | null;
      if (json?.method === "sendTransaction") submissions++;
    }
  });
  await page.exposeFunction(
    "__8183TestWalletRequest",
    async (request: Request) => {
      const key = keys[role];
      if (["REQUEST_ACCESS", "REQUEST_PUBLIC_KEY"].includes(request.type))
        return { publicKey: key.publicKey() };
      if (request.type === "REQUEST_CONNECTION_STATUS")
        return { isConnected: true };
      if (request.type === "REQUEST_NETWORK_DETAILS")
        return {
          networkDetails: {
            network: "TESTNET",
            networkUrl: "https://horizon-testnet.stellar.org",
            sorobanRpcUrl: profile.rpcUrl,
            networkPassphrase: network,
          },
        };
      if (request.type !== "SUBMIT_TRANSACTION")
        throw new Error("Unexpected wallet message.");
      if (approval === "decline")
        return {
          apiError: { code: -4, message: "Author-run test declined approval" },
        };
      if (
        request.networkPassphrase !== Networks.TESTNET ||
        request.accountToSign !== key.publicKey() ||
        !request.transactionXdr
      )
        throw new Error("Wallet bridge rejected network or signer.");
      const transaction = TransactionBuilder.fromXDR(
        request.transactionXdr,
        Networks.TESTNET,
      );
      if (
        !(transaction instanceof Transaction) ||
        transaction.source !== key.publicKey() ||
        BigInt(transaction.fee) > BigInt(profile.maxFee)
      )
        throw new Error("Wallet bridge rejected envelope.");
      const call = inspectInvocation(transaction);
      if (
        call.contractId !== profile.kernel ||
        ![
          "create_job",
          "set_provider",
          "set_budget",
          "fund",
          "submit",
          "complete",
          "reject",
          "claim_refund",
        ].includes(call.method)
      )
        throw new Error("Wallet bridge rejected invocation.");
      signedMethods.push(call.method);
      transaction.sign(key);
      if (approval === "switch-account") role = "provider";
      return {
        signedTransaction: transaction.toXDR(),
        signerAddress: key.publicKey(),
      };
    },
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "freighter", { value: true });
    window.addEventListener("message", (event) => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST"
      )
        return;
      const request = event.data as Request & { messageId: number };
      void window.__8183TestWalletRequest(request).then((response) =>
        window.postMessage(
          {
            ...response,
            source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
            messagedId: request.messageId,
          },
          window.location.origin,
        ),
      );
    });
  });
  const reader = new LiveCommerce(profile, {
    address: keys.client.publicKey(),
    sign: async () => {
      throw new Error("Read-only observer cannot sign.");
    },
  });
  const configure = async () => {
    await page.getByRole("button", { name: "Network settings" }).click();
    await page.getByRole("button", { name: "Use verified Testnet" }).click();
    await expect(page.locator(".live-banner")).toContainText(profile.symbol);
  };
  const connect = async (next: Role, description?: string) => {
    role = next;
    await page.locator(".wallet-button").click();
    await expect(page.locator("#notice")).toHaveText(
      "Wallet connected and payment token verified.",
    );
    if (description)
      await page.locator(".job-row").filter({ hasText: description }).click();
  };
  const openCreate = async (description: string, minutes = "15") => {
    await page.getByRole("button", { name: "+ Create job" }).click();
    await page.getByLabel("What needs to be delivered?").fill(description);
    await page
      .getByLabel("Evaluator address", { exact: true })
      .fill(keys.evaluator.publicKey());
    await page.getByLabel("Expiry in minutes").fill(minutes);
    await page.getByRole("button", { name: "Review new job" }).click();
    await page.getByRole("button", { name: "Continue to wallet" }).click();
  };
  const act = async (action: string, state: string) => {
    await page.getByLabel("Next step").selectOption(action);
    if (action === "set_provider")
      await page
        .getByLabel("Provider address", { exact: true })
        .fill(keys.provider.publicKey());
    if (action === "submit")
      await page.getByLabel("Work SHA-256 (required)").fill("cd".repeat(32));
    await page.getByRole("button", { name: "Review action" }).click();
    await page.getByRole("button", { name: "Continue to wallet" }).click();
    await expect(page.locator("#notice")).toContainText("confirmed.", {
      timeout: 60_000,
    });
    await expect(page.locator(".detail-head .badge")).toHaveText(state);
  };
  const recoverProviderAssignment = async (description: string) => {
    dropConfirmation = true;
    await page.getByLabel("Next step").selectOption("set_provider");
    await page
      .getByLabel("Provider address", { exact: true })
      .fill(keys.provider.publicKey());
    await page.getByRole("button", { name: "Review action" }).click();
    await page.getByRole("button", { name: "Continue to wallet" }).click();
    await expect(page.locator("#notice")).toContainText("unknown outcome", {
      timeout: 60_000,
    });
    const hash = await page.locator(".recovery-panel code").innerText();
    await expect
      .poll(async () => (await reader.server.getTransaction(hash)).status, {
        timeout: 30_000,
      })
      .toBe("SUCCESS");
    await page.reload();
    await configure();
    await connect("client", description);
    await expect(page.getByLabel("Next step")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Import provider from 8004" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Check transaction" }).click();
    await expect(page.locator("#notice")).toContainText(
      "Confirmed transaction recovered",
      { timeout: 60_000 },
    );
    await expect(page.locator(".detail-head .badge")).toHaveText("Open");
  };
  await page.goto("./");
  await configure();
  network = Networks.PUBLIC;
  await page.locator(".wallet-button").click();
  await expect(page.locator("#notice")).toContainText("Switch Freighter");
  expect(submissions).toBe(0);
  network = Networks.TESTNET;
  await connect("client");
  approval = "decline";
  await openCreate("Author-run rejected approval; no job should be sent");
  await expect(page.locator("#notice")).toContainText("declined approval");
  expect(submissions).toBe(0);
  approval = "switch-account";
  await openCreate(
    "Author-run account changed during approval; no job should be sent",
  );
  await expect(page.locator("#notice")).toContainText("account changed");
  expect(submissions).toBe(0);
  approval = "accept";
  await connect("client");
  await page.getByRole("button", { name: "+ Create job" }).click();
  await page
    .getByLabel("What needs to be delivered?")
    .fill("Author-run second-tab journal guard; no transaction");
  await page.getByRole("button", { name: "Review new job" }).click();
  const otherTab = await page.context().newPage();
  await otherTab.goto("./");
  const pendingKey = `8183:v1:testnet:${profile.kernel}:${profile.token}:pending`;
  await otherTab.evaluate(
    ({ key, source }) =>
      localStorage.setItem(
        key,
        JSON.stringify([
          { hash: "ab".repeat(32), method: "create_job", source },
        ]),
      ),
    { key: pendingKey, source: keys.client.publicKey() },
  );
  await page.getByRole("button", { name: "Continue to wallet" }).click();
  await expect(page.locator("#notice")).toContainText(
    "Check the tracked creation transaction",
  );
  expect(submissions).toBe(0);
  await otherTab.evaluate((key) => localStorage.removeItem(key), pendingKey);
  await otherTab.close();
  const receipts: ReceiptFile[] = [];
  for (const path of ["complete", "reject", "claim_refund"] as const) {
    const description = `Author-run browser ${path}; not independent customer evidence`;
    const initialClient = await reader.tokenBalance(keys.client.publicKey());
    const initialProvider = await reader.tokenBalance(
      keys.provider.publicKey(),
    );
    await connect("client");
    await openCreate(description, path === "claim_refund" ? "1" : "15");
    if (path === "complete") {
      await expect(page.locator("#notice")).toContainText("unknown outcome", {
        timeout: 60_000,
      });
      const hash = await page.locator(".recovery-panel code").innerText();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      await expect
        .poll(async () => (await reader.server.getTransaction(hash)).status, {
          timeout: 30_000,
        })
        .toBe("SUCCESS");
      await page.reload();
      await configure();
      await connect("client");
      await page.getByRole("button", { name: "+ Create job" }).click();
      await expect(page.locator("#notice")).toContainText(
        "Check its tracked transaction",
      );
      await expect(page.locator("#create-form")).toHaveCount(0);
      expect(submissions).toBe(1);
      failRecoveryRead = true;
      await page.getByRole("button", { name: "Check transaction" }).click();
      await expect(page.locator("#notice")).toContainText(
        "Transaction confirmed for job",
        { timeout: 60_000 },
      );
      await page.getByRole("button", { name: /^Load confirmed job/ }).click();
      await expect(page.locator(".detail-panel h2")).toHaveText(description);
    } else {
      await expect(page.locator("#notice")).toContainText("Job created", {
        timeout: 60_000,
      });
    }
    if (path === "complete") {
      await page
        .getByRole("button", { name: "Import provider from 8004" })
        .click();
      await expect(page.getByLabel("Identity Registry contract")).toHaveValue(
        defaultIdentityRegistry("testnet"),
      );
      await expect(page.getByRole("dialog")).toContainText(
        "Canonical registry selected by default",
      );
      await page.getByRole("button", { name: "Close dialog" }).click();
    }
    if (path === "complete") await recoverProviderAssignment(description);
    else await act("set_provider", "Open");
    await act("set_budget", "Open");
    await act("fund", "Funded");
    if (path === "complete") {
      await connect("provider", description);
      await act("submit", "Submitted");
      await connect("evaluator", description);
      await act("complete", "Completed");
    } else if (path === "reject") {
      await connect("evaluator", description);
      await act("reject", "Rejected");
    } else {
      const id = BigInt(
        (await page.locator(".detail-head .eyebrow").innerText()).replace(
          "JOB ",
          "",
        ),
      );
      const job = await reader.read(id);
      while (BigInt(Math.floor(Date.now() / 1000)) <= job.expires_at + 5n)
        await page.waitForTimeout(1000);
      await connect("provider", description);
      await page.getByRole("button", { name: "Refresh job" }).click();
      await act("claim_refund", "Expired");
    }
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download outcome receipt" })
      .click();
    const file = await (await download).path();
    if (!file) throw new Error("Receipt download unavailable.");
    const text = await readFile(file, "utf8");
    const receipt = await parseReceipt(text);
    receipts.push(receipt);
    console.info(
      `Author-run browser job ${receipt.receipt.jobId}: ${receipt.receipt.state} receipt verified.`,
    );
    const budget = BigInt(receipt.receipt.budget);
    expect(await reader.tokenBalance(keys.client.publicKey())).toBe(
      initialClient - (path === "complete" ? budget : 0n),
    );
    expect(await reader.tokenBalance(keys.provider.publicKey())).toBe(
      initialProvider + (path === "complete" ? budget : 0n),
    );
    await page
      .getByRole("button", { name: "Verify receipt", exact: false })
      .first()
      .click();
    await page.getByLabel("Receipt JSON").fill(text);
    await page
      .locator("dialog")
      .getByRole("button", { name: "Verify receipt", exact: true })
      .click();
    await expect(page.locator("#verification")).toContainText(
      "Verified terminal job",
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.reload();
    await configure();
    await connect("client", description);
    await expect(page.locator(".detail-head .badge")).toHaveText(
      receipt.receipt.state,
    );
  }
  const output = resolve(root, "artifacts/month-two/browser-live");
  expect(submissions).toBe(16);
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        schema: "stellar-8183/browser-author-run/v1",
        evidenceType: "author-run",
        independentParticipant: false,
        walletBoundary:
          "Real Freighter API message protocol with author-controlled Node-only testnet signer; not a real extension UI or customer session",
        profile,
        sourceCommit,
        applicationFiles,
        applicationUrl: process.env.CONSOLE_LIVE_URL ?? "http://127.0.0.1:4174",
        generatedAt: new Date().toISOString(),
        submissions,
        signedMethods,
        receipts,
      },
      null,
      2,
    ),
  );
});
