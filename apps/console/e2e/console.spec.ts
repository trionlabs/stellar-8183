import { expect, test } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { VERIFIED_TESTNET_PROFILE } from "../src/deployment.js";

test("opens on the verified Stellar Testnet deployment", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("./");

  await expect(
    page.getByRole("heading", { name: "Fund work. Settle on-chain." }),
  ).toBeVisible();
  await expect(page.locator(".live-banner")).toContainText("Stellar Testnet");
  await expect(page.locator(".live-banner")).toContainText("DEMO8183");
  await expect(page.locator(".connect-gate")).toContainText(
    "Transactions are submitted to Stellar",
  );
  await expect(
    page.getByRole("link", { name: "view contract" }),
  ).toHaveAttribute("href", new RegExp(VERIFIED_TESTNET_PROFILE.kernel));
  await expect(page.locator("body")).not.toContainText(/local rehearsal/i);
  await expect(page.locator("body")).not.toContainText(/demo wallet/i);
  await expect(page.locator("body")).not.toContainText(/advance 1 hour/i);
  expect(errors).toEqual([]);
});

test("requires a real Freighter wallet before any write", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByRole("button", { name: "+ Create job" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Connect Freighter" }).click();
  await expect(page.locator("#notice")).toContainText(
    "Install the Freighter browser extension",
  );
  await expect(page.locator(".job-row")).toHaveCount(0);
});

test("network settings expose only verified Testnet or a reviewed Mainnet profile", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Network settings" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Choose a network" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Stellar Testnet" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Stellar Mainnet" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Use imported Mainnet canary" }),
  ).toBeDisabled();
  await expect(dialog.locator('input[name="rpcUrl"]')).toHaveCount(0);
  await expect(dialog.locator('input[name="kernel"]')).toHaveCount(0);

  await dialog.getByLabel("Reviewed profile JSON").setInputFiles({
    name: "valuable-mainnet.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...VERIFIED_TESTNET_PROFILE,
        id: "mainnet-canary",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
        symbol: "USDC",
        canaryAcknowledged: true,
      }),
    ),
  });
  await expect(dialog.locator(".dialog-error")).toContainText(
    "restricted to the acknowledged DEMO8183 canary profile",
  );

  await dialog.getByLabel("Reviewed profile JSON").setInputFiles({
    name: "reviewed-mainnet.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...VERIFIED_TESTNET_PROFILE,
        id: "mainnet-canary",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
        canaryAcknowledged: true,
      }),
    ),
  });
  await expect(
    dialog.getByRole("button", { name: "Use imported Mainnet canary" }),
  ).toBeEnabled();

  await dialog.getByRole("button", { name: "Use verified Testnet" }).click();
  await expect(page.locator("#notice")).toContainText("Testnet selected");
  await expect(page.locator(".live-banner")).toContainText("Stellar Testnet");
});

test("brand navigation stays inside the deployed project path", async ({
  page,
}) => {
  await page.goto("./");
  const expected = new URL("./", page.url()).href;
  await page.getByRole("link", { name: "8183 home" }).click();
  await expect(page).toHaveURL(expected);
  await expect(
    page.getByRole("heading", { name: "Fund work. Settle on-chain." }),
  ).toBeVisible();
});

test("desktop and mobile layouts remain readable without overflow", async ({
  page,
}) => {
  await mkdir("../../artifacts/month-two", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("./");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../../artifacts/month-two/console-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Fund work. Settle on-chain." }),
  ).toBeVisible();
  await page.screenshot({
    path: "../../artifacts/month-two/console-mobile.png",
    fullPage: true,
  });
});

test("stopping unresolved tracking preserves a public reference", async ({
  page,
}) => {
  await page.goto("./");
  const hash = "ab".repeat(32);
  const source = "GC2OHQG6JNXJYV36A4Q7NOUIVEUZZYPFYH747H6C3AWXQII2WCOVSFSS";
  await page.evaluate(
    ({ profile, hash, source }) =>
      localStorage.setItem(
        `8183:v1:testnet:${profile.kernel}:${profile.token}:pending`,
        JSON.stringify([{ hash, source, method: "create_job" }]),
      ),
    { profile: VERIFIED_TESTNET_PROFILE, hash, source },
  );
  await page.reload();

  await page.getByRole("button", { name: "Stop local tracking" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "does not cancel the transaction or prove it failed",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Save reference and stop tracking" })
    .click();
  const path = await (await download).path();
  const reference = JSON.parse(await readFile(path!, "utf8"));
  expect(reference.submission.hash).toBe(hash);
  expect(reference.status).toBe("unverified-reference");
  await expect(page.locator(".recovery-panel")).toHaveCount(0);
  await expect(page.locator("#notice")).toContainText(
    "did not cancel the transaction or verify its outcome",
  );
});
