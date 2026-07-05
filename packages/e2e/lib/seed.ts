import { execSync } from "node:child_process";
import { EXAMPLE_DIR, ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, USER_PASSWORD } from "./env.js";

/**
 * Run a `localbase` CLI sub-command inside the example project dir. Returns
 * combined stdout+stderr. Throws on non-zero exit.
 */
export function localbase(args: string): string {
  return execSync(`localbase ${args}`, {
    cwd: EXAMPLE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
}

/**
 * Best-effort: create a user if absent, then (re)set their password to a known
 * value. Survives repeated runs and the fact that `_users` is not wiped by
 * `db reset`.
 */
export function ensureUser(email: string, password: string): void {
  try {
    localbase(`auth create-user --email ${email} --password ${password}`);
  } catch (err) {
    const out = String(err instanceof Error ? err.message : err);
    // Any non-"already exists" failure is a real problem — surface it.
    if (!/already|exists|in use|registered/i.test(out)) throw err;
    localbase(`auth reset-password --email ${email} --password ${password}`);
  }
}

/** Seed the two canonical accounts used across the suite. */
export function seedAccounts(): void {
  ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD);
  ensureUser(USER_EMAIL, USER_PASSWORD);
  // Make the admin an admin (idempotent). The first-signup bootstrap only
  // fires on an empty `_users`, which we cannot guarantee, so promote explicitly.
  localbase(`admin promote ${ADMIN_EMAIL}`);
}
