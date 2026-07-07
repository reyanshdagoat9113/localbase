import fs from "node:fs";
import path from "node:path";
import {
  Database,
  createBackup,
  restoreBackup,
  BackupError,
  isDatabaseLocked,
} from "@localbase/core";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

export async function migrateCommand(): Promise<void> {
  const cwd = process.cwd();
  const { dbPath, dbDir, config } = await loadConfig(cwd);

  // Ensure .localbase/ directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database({
    path: dbPath,
    schema: config.tables,
    auth: config.auth,
    dataDir: dbDir,
    buckets: config.buckets,
    jobs: config.jobs,
  });

  try {
    const applied = db.getAppliedMigrations();
    const tableNames = Object.keys(config.tables);
    if (config.auth?.enabled) {
      tableNames.push("_users", "_sessions", "_admin_requests");
    }

    log.heading("Migration status:");
    for (const name of tableNames) {
      const status = applied.has(name) ? "✔ applied" : "○ pending";
      console.log(`  ${name}: ${status}`);
    }

    // Run any pending migrations
    const newMigrations = db.migrate();
    if (newMigrations.length > 0) {
      log.success(`Applied ${newMigrations.length} new migration(s): ${newMigrations.join(", ")}`);
    } else {
      log.info("All migrations are up to date.");
    }
  } finally {
    db.close();
  }
}

export async function resetCommand(): Promise<void> {
  const cwd = process.cwd();
  const { dbPath, dbDir, config } = await loadConfig(cwd);

  // Ensure .localbase/ directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database({
    path: dbPath,
    schema: config.tables,
    auth: config.auth,
    dataDir: dbDir,
    buckets: config.buckets,
    jobs: config.jobs,
  });

  try {
    log.warn("Dropping all user tables and re-running migrations...");
    const applied = db.reset();
    log.success(`Reset complete. Re-applied ${applied.length} migration(s): ${applied.join(", ")}`);
  } finally {
    db.close();
  }
}

/**
 * `localbase db backup [out]`.
 *
 * Takes a live, online backup: the SQLite database is copied via SQLite's
 * backup API (safe under concurrent reads) after a WAL checkpoint, and the
 * `<dataDir>/storage/` tree is copied alongside it. A `manifest.json`
 * records a SHA-256 of every included file plus the durable PRAGMAs, so the
 * restore path can verify integrity before touching live data.
 *
 * The server MAY be running during a backup — it is designed to be safe
 * under live traffic.
 */
export async function backupCommand(opts: {
  out: string;
}): Promise<void> {
  const cwd = process.cwd();
  const { dbPath, dbDir, config } = await loadConfig(cwd);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database({
    path: dbPath,
    schema: config.tables,
    auth: config.auth,
    dataDir: dbDir,
    buckets: config.buckets,
    jobs: config.jobs,
  });

  // Default output is a timestamped sibling of the .localbase dir, e.g.
  // <cwd>/backups/localbase-backup-20260706-120000. Resolved against cwd so
  // relative paths behave predictably.
  const outDir = path.resolve(
    opts.out && opts.out.length > 0
      ? opts.out
      : path.join(cwd, "backups", defaultBackupName())
  );

  try {
    log.info(`Backing up ${path.relative(cwd, dbPath)} -> ${path.relative(cwd, outDir)}`);
    const result = await createBackup({ database: db, destDir: outDir });
    log.success(
      `Backup complete: ${result.fileCount} file(s) at ${path.relative(cwd, result.dir)}`
    );
    log.hint("Restore with: localbase db restore " + path.relative(cwd, result.dir));
  } finally {
    db.close();
  }
}

/**
 * `localbase db restore <backup>`.
 *
 * Verifies the backup's manifest checksums and runs `PRAGMA integrity_check`
 * on the backed-up database BEFORE replacing anything. Only if every check
 * passes does it atomically swap the live database file and storage tree.
 *
 * The server MUST be stopped before running this. We make a best-effort
 * check for an SQLite file lock (a running server holds the file open); if
 * we cannot acquire the lock we refuse rather than risk a torn write.
 */
export async function restoreCommand(opts: {
  backup: string;
}): Promise<void> {
  const cwd = process.cwd();
  const { dbPath, dbDir, config } = await loadConfig(cwd);

  const backupDir = path.resolve(cwd, opts.backup);
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup directory does not exist: ${opts.backup}`);
  }
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Not a LocalBase backup (no manifest.json): ${opts.backup}`
    );
  }

  // Best-effort "is the server running?" guard. A running server holds the
  // main DB file open; the probe below tries to open it with a zero timeout
  // and refuses if it comes back busy. On platforms that don't surface the
  // lock this is advisory, which is why the warning above is printed too.
  if (isDatabaseLocked(dbPath)) {
    throw new Error(
      `The database file appears to be locked by a running server (${dbPath}). ` +
        `Stop the server (Ctrl+C on \`localbase dev\`) and try again.`
    );
  }

  log.warn("Restoring will REPLACE the live database and storage tree.");
  log.warn("Make sure the dev/studio server is STOPPED before continuing.");
  log.info(`Backup:  ${path.relative(cwd, backupDir)}`);
  log.info(`Target:  ${path.relative(cwd, dbPath)}`);

  try {
    const result = await restoreBackup({
      backupDir,
      dbPath,
      dataDir: dbDir,
    });
    log.success(
      `Restore complete: ${result.fileCount} file(s) replaced the live data.`
    );
    log.hint("Start the server again with: localbase dev");
  } catch (err) {
    if (err instanceof BackupError) {
      // Checksum / integrity / manifest failures mean the live data was NOT
      // touched — surface that clearly so the user knows they are safe.
      const untouched =
        err.code === "checksum" ||
        err.code === "integrity" ||
        err.code === "manifest";
      if (untouched) {
        log.error(`Restore refused (${err.code}): ${err.message}`);
        log.hint("Live data was not modified. The backup is not safe to restore.");
      } else {
        log.error(`Restore failed (${err.code}): ${err.message}`);
      }
    }
    throw err;
  }
}

/**
 * Timestamped backup directory name, e.g. `localbase-backup-20260706-120000`.
 * Local time is used because a human runs this manually and wants to read it.
 */
function defaultBackupName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `localbase-backup-` +
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
