import fs from "node:fs";
import { Database } from "@localbase/core";
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
  });

  try {
    const applied = db.getAppliedMigrations();
    const tableNames = Object.keys(config.tables);
    if (config.auth?.enabled) {
      tableNames.push("_users", "_sessions");
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
  });

  try {
    log.warn("Dropping all user tables and re-running migrations...");
    const applied = db.reset();
    log.success(`Reset complete. Re-applied ${applied.length} migration(s): ${applied.join(", ")}`);
  } finally {
    db.close();
  }
}
