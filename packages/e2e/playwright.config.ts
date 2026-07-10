import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL, CLI_ENTRY, DATA_DIR, EXAMPLE_DIR } from "./lib/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E suite for the LocalBase Admin Studio.
 *
 * The suite drives the *real* admin SPA against the *real* `localbase dev`
 * server pointed at `examples/task-board`. `webServer` boots that server;
 * `globalSetup` seeds accounts + caches the admin session.
 *
 * The dev server runs against an ephemeral per-run data directory
 * (`DATA_DIR`, passed via the `LOCALBASE_DATA_DIR` env var) so the suite
 * never mutates or depends on `examples/task-board/.localbase`. This is the
 * Workstream 2.1 determinism fix — two consecutive runs from a clean checkout
 * both pass without manual cleanup.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared mutable dev DB; run serially for determinism
  forbidOnly: !!process.env.CI,
  // Zero retries everywhere: the suite is deterministic (ephemeral per-run
  // data dir, Workstream 2.1), so a retry would only mask a real regression.
  // Gate E2E-P0 requires 18/18 with no retries needed.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  globalSetup: path.resolve(__dirname, "global-setup.ts"),
  globalTeardown: path.resolve(__dirname, "global-teardown.ts"),

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
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_ENTRY)} dev`,
    cwd: EXAMPLE_DIR,
    url: `${BASE_URL}/admin`,
    // Never reuse a server: an existing one would almost certainly be backed
    // by unrelated state (a developer's `localbase dev`, or a previous run's
    // data dir), which is exactly the nondeterminism Workstream 2.1 removes.
    reuseExistingServer: false,
    timeout: 60_000,
    // Point the dev server at the ephemeral per-run data directory. The CLI's
    // config loader resolves `LOCALBASE_DATA_DIR` over `<cwd>/.localbase`.
    env: { ...process.env, LOCALBASE_DATA_DIR: DATA_DIR },
  },
});
