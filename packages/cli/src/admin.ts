import fs from "node:fs";
import { Database, Auth, AuthError, resolveAuthConfig } from "@localbase/core";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

/**
 * Open the database with auth enabled, returning an `Auth` instance for role
 * management. Mirrors the pattern in `cli/src/auth.ts`: the CLI requires auth
 * to be enabled because the `Auth` class (and the `_users.role` column) only
 * exist when auth is configured.
 */
function openAuthDb() {
  const cwd = process.cwd();
  return loadConfig(cwd).then(({ dbPath, dbDir, config }) => {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const authConfig = config.auth;
    if (!authConfig?.enabled) {
      throw new Error(
        "Auth is not enabled. The admin role system requires auth — add " +
          "`auth: { enabled: true, jwtSecret: '...' }` to localbase.config.ts first."
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

// ── localbase admin:promote <email> ────────────────────────────

export interface PromoteOptions {
  email?: string;
}

export async function promoteCommand(
  opts: PromoteOptions
): Promise<void> {
  const email = opts.email;
  if (!email) {
    log.error("Email is required: `localbase admin:promote <email>`.");
    process.exit(1);
  }

  try {
    const { db, auth } = await openAuthDb();
    try {
      const before = auth.countAdmins();
      const user = auth.setRole(email, "admin");
      const after = auth.countAdmins();
      if (before === after) {
        log.info(`${email} was already an admin.`);
      } else {
        log.success(`Promoted ${email} (#${user.id}) to admin. (${after} admin${after === 1 ? "" : "s"} total)`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    handleAuthError(err);
  }
}

// ── localbase admin:demote <email> ─────────────────────────────

export interface DemoteOptions {
  email?: string;
  /** Skip the interactive confirmation prompt. */
  force?: boolean;
}

export async function demoteCommand(
  opts: DemoteOptions
): Promise<void> {
  const email = opts.email;
  if (!email) {
    log.error("Email is required: `localbase admin:demote <email>`.");
    process.exit(1);
  }

  try {
    const { db, auth } = await openAuthDb();
    try {
      const adminCount = auth.countAdmins();
      // The last-admin lockout is enforced inside setRole too, but we check
      // up front so we can give a clearer message before any prompting.
      if (adminCount <= 1) {
        log.error(
          `Cannot demote: ${email} is the last admin. Promote another user first.`
        );
        process.exit(1);
      }

      // Confirmation. The plan calls for self-demotion confirmation; we apply
      // a lightweight prompt to ALL demotions since demoting *any* admin
      // shrinks the admin pool. `--force` skips it (for scripts/CI).
      if (!opts.force) {
        const confirmed = await confirm(
          `Demote ${email} from admin? This reduces the admin count to ${adminCount - 1}. [y/N] `
        );
        if (!confirmed) {
          log.info("Aborted.");
          return;
        }
      }

      const user = auth.setRole(email, "user");
      log.success(`Demoted ${email} (#${user.id}) to user.`);
    } finally {
      db.close();
    }
  } catch (err) {
    handleAuthError(err);
  }
}

/**
 * Read a yes/no confirmation from stdin. Resolves true for an affirmative
 * answer (y/yes). Non-TTY environments default to false unless --force is
 * passed, which is the safe default for a destructive role change.
 */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // No interactive stdin (piped/CI) — don't block on a prompt that can't
      // be answered. Caller should pass --force in those environments.
      log.info(`${question}(no TTY — pass --force to confirm)`);
      resolve(false);
      return;
    }
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const answer = String(data).trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    });
  });
}
