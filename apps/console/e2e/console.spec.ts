import { test, expect, type Page } from "@playwright/test";

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
  await page.goto("/");
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
  await page.goto("/");
  await createJob(page);
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByLabel("Rehearsal role").selectOption("evaluator");
  await act(page, "reject");
  await expect(page.locator(".detail-head .badge")).toHaveText("Rejected");
  await page.getByLabel("Rehearsal role").selectOption("client");
  await createJob(page, "Review the research report");
  await act(page, "set_budget");
  await act(page, "fund");
  await page.getByRole("button", { name: "Advance 1 hour" }).click();
  await page.getByLabel("Rehearsal role").selectOption("provider");
  await act(page, "claim_refund");
  await expect(page.locator(".detail-head .badge")).toHaveText("Expired");
  await expect(page.locator("#action-form")).toHaveCount(0);
});

test("descriptions render as text and the mobile workspace does not overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
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
  await page.goto("/");
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
