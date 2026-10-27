import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: {
    baseURL: process.env.CONSOLE_BASE_URL ?? "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    channel:
      process.env.PLAYWRIGHT_CHANNEL ??
      (process.platform === "darwin" ? "chrome" : "chromium"),
  },
  webServer: process.env.CONSOLE_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
      },
});
