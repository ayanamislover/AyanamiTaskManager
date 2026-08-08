import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/desktop/e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "output/e2e/results.json" }],
  ],
  webServer: {
    command: "pnpm exec tsx scripts/start-e2e.ts",
    url: "http://127.0.0.1:9999",
    timeout: 120_000,
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://127.0.0.1:9999",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
