import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, EXAMPLE_DIR } from "./lib/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E suite for the LocalBase Admin Studio.
 *
 * The suite drives the *real* admin SPA against the *real* `localbase dev`
 * server pointed at `examples/task-board`. `webServer` boots that server;
 * `globalSetup` seeds accounts + caches the admin session.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared mutable dev DB; run serially for determinism
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  globalSetup: path.resolve(__dirname, "global-setup.ts"),

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    // The sidebar (and all nav) is hidden below `md` (768px). Use a desktop
    // viewport so the app is actually drivable.
    viewport: { width: 1280, height: 800 },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "localbase dev",
    cwd: EXAMPLE_DIR,
    url: `${BASE_URL}/admin`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
