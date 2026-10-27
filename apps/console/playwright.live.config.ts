import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "live-e2e",
  workers: 1,
  timeout: 420_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.CONSOLE_LIVE_URL ?? "http://127.0.0.1:4174",
    channel:
      process.env.PLAYWRIGHT_CHANNEL ??
      (process.platform === "darwin" ? "chrome" : "chromium"),
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  webServer: process.env.CONSOLE_LIVE_URL
    ? undefined
    : {
        command: "pnpm preview --port 4174",
        url: "http://127.0.0.1:4174",
        reuseExistingServer: false,
      },
});
