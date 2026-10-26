import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function createJob(
  page: Page,
  description = "Translate the product brief",
): Promise<void> {
  await page.getByRole("button", { name: "+ Create job" }).click();
  await page.getByLabel("What needs to be delivered?").fill(description);
  await page.getByRole("button", { name: "Review new job" }).click();
  await page.getByRole("button", { name: "Confirm rehearsal action" }).click();
  await expect(page.locator(".detail-panel h2")).toHaveText(description);
}
async function act(page: Page, value: string): Promise<void> {
  await page.getByLabel("Next step").selectOption(value);
  if (value === "submit")
    await page.getByLabel("Work SHA-256 (required)").fill("ab".repeat(32));
  await page.getByRole("button", { name: "Review action" }).click();
  await page.getByRole("button", { name: "Confirm rehearsal action" }).click();
}

test("client, provider, and evaluator complete a job and export a verifiable rehearsal receipt", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByText("You're in a local rehearsal.")).toBeVisible();
  await createJob(page);
  await act(page, "set_budget");
  await act(page, "fund");
  await expect(page.locator(".detail-head .badge")).toHaveText("Funded");
  await page.getByLabel("Rehearsal role").selectOption("provider");
  await act(page, "submit");
  await page.getByLabel("Rehearsal role").selectOption("evaluator");
  await act(page, "complete");
  await expect(page.locator(".detail-head .badge")).toHaveText("Completed");
  await expect(page.locator(".terminal-outcome")).toHaveText(
    "Final outcome: Completed",
  );
  await expect(page.locator(".progress")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download outcome receipt" }).click();
  const path = await (await download).path();
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path!, "utf8");
  expect(JSON.parse(text).receipt.evidenceType).toBe("rehearsal");
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
    "Content hash matches",
  );
  await expect(page.locator("#verification")).toContainText("no on-chain");
});

test("funded rejection refunds and expired refund can be triggered by the provider", async ({
  page,
}) => {
  await page.goto("./");
  await createJob(page);
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByLabel("Rehearsal role").selectOption("evaluator");
  await act(page, "reject");
  await expect(page.locator(".detail-head .badge")).toHaveText("Rejected");
  await expect(page.locator(".terminal-outcome")).toHaveText(
    "Final outcome: Rejected",
  );
  await expect(page.locator(".progress")).toHaveCount(0);
  await expect(page.locator(".commitment")).toHaveCount(0);
  await page.getByLabel("Rehearsal role").selectOption("client");
  await createJob(page, "Review the research report");
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByRole("button", { name: "Advance 1 hour" }).click();
  await page.getByLabel("Rehearsal role").selectOption("provider");
  await act(page, "claim_refund");
  await expect(page.locator(".detail-head .badge")).toHaveText("Expired");
  await expect(page.locator(".terminal-outcome")).toHaveText(
    "Final outcome: Expired",
  );
  await expect(page.locator(".progress")).toHaveCount(0);
  await expect(page.locator("#action-form")).toHaveCount(0);
});

test("Open cancellation displays its outcome without claiming funding or submission", async ({
  page,
}) => {
  await page.goto("./");
  await createJob(page, "Cancel before funding");
  await expect(page.locator(".progress .done")).toHaveText(["1. Open"]);
  await act(page, "reject");
  await expect(page.locator(".detail-head .badge")).toHaveText("Rejected");
  await expect(page.locator(".terminal-outcome")).toHaveText(
    "Final outcome: Rejected",
  );
  await expect(page.locator(".progress")).toHaveCount(0);
  await expect(page.locator(".commitment")).toHaveCount(0);
});

test("descriptions render as text and the mobile workspace does not overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await createJob(page, '<img src=x onerror="window.injected=true">');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as { injected?: boolean }).injected,
    ),
  ).toBeUndefined();
  await expect(page.locator(".detail-panel img")).toHaveCount(0);
});

test("mainnet configuration rejects a valuable-asset profile", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Network settings" }).click();
  await page
    .getByLabel("Network", { exact: false })
    .selectOption("mainnet-canary");
  await page
    .getByLabel("Kernel contract")
    .fill("CA4LPJIQZEGMCYA4WV5W4F6X6RGLGX2YO7IRZJKVXSEJXOZNTTYUEBIW");
  await page
    .getByLabel("Immutable payment token")
    .fill("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
  await page.getByRole("button", { name: "Use deployment" }).click();
  await expect(page.locator(".dialog-error")).toContainText("DEMO8183");
});

test("loads the bundled testnet profile at the deployed project path", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("link", { name: "8183 home" }).click();
  await expect(
    page.getByRole("heading", { name: "Work, with a clear finish." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Network settings" }).click();
  await page
    .getByRole("button", { name: "Load verified testnet profile" })
    .click();
  await expect(page.getByLabel("Kernel contract")).toHaveValue(
    "CDQQSBNGKJ6CR2VG65P73OJUIMHOLYNFJWXCLKANOACJ4MXXQDJVFUNW",
  );
  await expect(page.getByLabel("Symbol", { exact: true })).toHaveValue(
    "DEMO8183",
  );
  await page.getByRole("button", { name: "Use deployment" }).click();
  await expect(page.locator(".live-banner")).toContainText(
    "Pinned payment asset: DEMO8183",
  );
  await expect(
    page.getByRole("button", { name: "Connect wallet" }),
  ).toBeVisible();
});

test("exports desktop and mobile rehearsal previews", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("./");
  await createJob(page, "Translate the product brief into Spanish");
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByLabel("Rehearsal role").selectOption("provider");
  await act(page, "submit");
  await page.getByLabel("Rehearsal role").selectOption("client");
  await createJob(page, "Summarize customer research findings");
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByLabel("Rehearsal role").selectOption("evaluator");
  await page
    .locator(".job-row")
    .filter({ hasText: "Translate the product brief" })
    .click();
  await mkdir("../../artifacts/month-two", { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../../artifacts/month-two/console-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    page.getByRole("heading", { name: "Work, with a clear finish." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../artifacts/month-two/console-mobile.png",
    fullPage: false,
  });
  await page.locator(".detail-panel").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../artifacts/month-two/console-mobile-job.png",
    fullPage: false,
  });
});

test("removing an unresolved tracking reminder requires a saved reference and does not claim cancellation", async ({
  page,
}) => {
  await page.route("**/testnet-profile.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.goto("./");
  await page.getByRole("button", { name: "Network settings" }).click();
  await page
    .getByRole("button", { name: "Load verified testnet profile" })
    .click();
  await expect(page.getByLabel("Kernel contract")).toHaveValue(
    /^C[A-Z2-7]{55}$/,
  );
  await expect(page.getByLabel("Immutable payment token")).toHaveValue(
    /^C[A-Z2-7]{55}$/,
  );
  await expect(
    page.getByRole("button", { name: "Use deployment" }),
  ).toBeEnabled();
  const kernel = await page.getByLabel("Kernel contract").inputValue();
  const token = await page.getByLabel("Immutable payment token").inputValue();
  const hash = "ab".repeat(32);
  const source = "GC2OHQG6JNXJYV36A4Q7NOUIVEUZZYPFYH747H6C3AWXQII2WCOVSFSS";
  await page.evaluate(
    ({ kernel, token, hash, source }) =>
      localStorage.setItem(
        `8183:v1:testnet:${kernel}:${token}:pending`,
        JSON.stringify([{ hash, source, method: "create_job" }]),
      ),
    { kernel, token, hash, source },
  );
  await page.getByRole("button", { name: "Use deployment" }).click();
  await page.getByRole("button", { name: "Stop local tracking" }).click();
  await expect(page.locator("dialog")).toContainText(
    "does not cancel the transaction or prove it failed",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save reference and stop tracking" })
    .click();
  const path = await (await download).path();
  const { readFile } = await import("node:fs/promises");
  const reference = JSON.parse(await readFile(path!, "utf8"));
  expect(reference.submission.hash).toBe(hash);
  expect(reference.status).toBe("unverified-reference");
  await expect(page.locator(".recovery-panel")).toHaveCount(0);
  await expect(page.locator("#notice")).toContainText(
    "did not cancel the transaction or verify its outcome",
  );
});
