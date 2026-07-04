import { existsSync } from "node:fs";
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
