import { defineConfig } from "@playwright/test";

const baseURL = process.env.JUDGE_BASE_URL;
const executablePath = process.env.JUDGE_CHROMIUM_EXECUTABLE;
if (!baseURL || !executablePath) throw new Error("judge runtime is not configured");

export default defineConfig({
  testDir: "../../e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  globalTimeout: 300_000,
  reporter: "line",
  outputDir: "../../.local/judge-results",
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      executablePath,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--no-first-run"],
    },
  },
});
