import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Walk up from `process.cwd()` until we find the repo root (the directory that
 * contains `examples/task-board`). Anchoring here — instead of to
 * `import.meta.url` — is essential: Playwright transpiles the TS config to a
 * cache dir before running it, so `__dirname` resolves to the cache, not the
 * source tree. `process.cwd()` is stable across config/globalSetup/tests.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "examples", "task-board", "localbase.config.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the LocalBase repo root (looking for examples/task-board). " +
      "Run the suite from within the repo."
  );
}

export const REPO_ROOT = findRepoRoot();

/** Base URL of the running `localbase dev` server. */
export const BASE_URL = process.env.LOCALBASE_URL ?? "http://127.0.0.1:5180";

/** The example project the dev server runs against. */
export const EXAMPLE_DIR = path.join(REPO_ROOT, "examples", "task-board");

/**
 * Ephemeral, per-run LocalBase data directory (Workstream 2.1).
 *
 * The dev server and CLI seed commands are pointed at this directory via the
 * `LOCALBASE_DATA_DIR` environment variable, so the suite never touches the
 * checked-in `examples/task-board/.localbase`. A unique suffix (pid + a random
 * token) keeps concurrent runs (rare, but possible in local dev) from
 * colliding, and `global-teardown` removes it at the end of the run.
 *
 * `LOCALBASE_E2E_DATA_DIR` lets a caller pin a stable directory (handy while
 * debugging a flaky test against known state); otherwise we mint a fresh one
 * under the OS temp dir.
 */
export const DATA_DIR =
  process.env.LOCALBASE_E2E_DATA_DIR ??
  path.join(os.tmpdir(), `localbase-e2e-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

/** Canonical seed accounts (created/refreshed by global-setup every run). */
export const ADMIN_EMAIL = "e2e-admin@localbase.test";
export const ADMIN_PASSWORD = "e2e-admin-password-123";
export const USER_EMAIL = "e2e-user@localbase.test";
export const USER_PASSWORD = "e2e-user-password-123";

/** Where the logged-in admin session is cached between tests. */
export const AUTH_FILE = path.join(REPO_ROOT, "packages", "e2e", ".auth", "admin.json");

/** localStorage key the admin SPA stores its session under. */
export const SESSION_KEY = "localbase.admin.session";

/** Playwright origin the storageState is scoped to. */
export const APP_ORIGIN = BASE_URL;
