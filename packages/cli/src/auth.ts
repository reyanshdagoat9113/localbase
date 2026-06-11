import fs from "node:fs";
import { Database, Auth, AuthError, resolveAuthConfig } from "@localbase/core";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

/**
 * Open the database with auth enabled. The CLI requires auth to be enabled
 * in the config — there's no way to manage users without a configured
 * `jwtSecret` (the Auth class needs it for hashing salts, etc., even
 * though admin commands don't issue tokens).
 */
function openAuthDb() {
  const cwd = process.cwd();
  return loadConfig(cwd).then(({ dbPath, dbDir, config }) => {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const authConfig = config.auth;
    if (!authConfig?.enabled) {
      throw new Error(
        "Auth is not enabled. Add `auth: { enabled: true, jwtSecret: '...' }` " +
          "to localbase.config.ts first."
      );
    }

    const { config: resolved } = resolveAuthConfig(authConfig);
    const db = new Database({
      path: dbPath,
      schema: config.tables,
      auth: authConfig,
    });
    const auth = new Auth(db, resolved);
    return { db, auth };
  });
}

function handleAuthError(err: unknown): never {
  if (err instanceof AuthError) {
    log.error(err.message);
  } else if (err instanceof Error) {
    log.error(err.message);
  } else {
    log.error(String(err));
  }
  process.exit(1);
}

// ── localbase auth create-user ────────────────────────────────

export interface CreateUserOptions {
  email?: string;
  password?: string;
}

export async function createUserCommand(
  opts: CreateUserOptions
): Promise<void> {
  const email = opts.email ?? process.env.AUTH_EMAIL;
  const password = opts.password ?? process.env.AUTH_PASSWORD;

  if (!email || !password) {
    log.error("Both --email and --password are required (or set AUTH_EMAIL and AUTH_PASSWORD env vars).");
    process.exit(1);
  }

  try {
    const { db, auth } = await openAuthDb();
    try {
      const user = await auth.createUser({ email, password });
      log.success(`Created user #${user.id}: ${user.email}`);
    } finally {
      db.close();
    }
  } catch (err) {
    handleAuthError(err);
  }
}

// ── localbase auth list-users ─────────────────────────────────

export async function listUsersCommand(): Promise<void> {
  try {
    const { db, auth } = await openAuthDb();
    try {
      const users = auth.listUsers();
      if (users.length === 0) {
        log.info("No users found.");
        return;
      }
      log.heading(`Users (${users.length}):`);
      for (const u of users) {
        const created = u.created_at ?? "?";
        console.log(`  #${u.id}  ${u.email}  (created ${created})`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    handleAuthError(err);
  }
}

// ── localbase auth reset-password ─────────────────────────────

export interface ResetPasswordOptions {
  email?: string;
  password?: string;
}

export async function resetPasswordCommand(
  opts: ResetPasswordOptions
): Promise<void> {
  const email = opts.email ?? process.env.AUTH_EMAIL;
  const password = opts.password ?? process.env.AUTH_PASSWORD;

  if (!email || !password) {
    log.error("Both --email and --password are required (or set AUTH_EMAIL and AUTH_PASSWORD env vars).");
    process.exit(1);
  }

  try {
    const { db, auth } = await openAuthDb();
    try {
      await auth.setPassword(email, password);
      log.success(`Reset password for ${email}.`);
    } finally {
      db.close();
    }
  } catch (err) {
    handleAuthError(err);
  }
}
