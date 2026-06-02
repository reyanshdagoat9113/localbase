import type Database from "better-sqlite3";
import type { DatabaseSchema } from "@localbase/shared";
import { schemaToDDL } from "./ddl.js";

const MIGRATIONS_TABLE = "_migrations";

/**
 * Ensures the _migrations tracking table exists.
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT NOT NULL UNIQUE,
      "applied_at" TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Returns the set of migration names that have already been applied.
 */
export function getAppliedMigrations(db: Database.Database): Set<string> {
  ensureMigrationsTable(db);
  const rows = db
    .prepare(`SELECT "name" FROM "${MIGRATIONS_TABLE}"`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Runs pending migrations for the given schema.
 * Each table in the schema is treated as one migration.
 * Already-applied tables are skipped.
 * Everything runs inside a single transaction.
 *
 * Returns the list of newly applied migration names.
 */
export function runMigrations(
  db: Database.Database,
  schema: DatabaseSchema
): string[] {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);

  const allDDL = schemaToDDL(schema);
  const tableNames = Object.keys(schema);
  const appliedNames: string[] = [];

  const migrate = db.transaction(() => {
    for (let i = 0; i < tableNames.length; i++) {
      const name = tableNames[i];
      if (applied.has(name)) continue;

      // Run the CREATE TABLE statement
      db.exec(allDDL[i]);

      // Record the migration
      db.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES (?)`
      ).run(name);

      appliedNames.push(name);
    }
  });

  migrate();
  return appliedNames;
}

/**
 * Drops all user tables and re-runs migrations.
 * Useful for `localbase db reset`.
 */
export function resetDatabase(
  db: Database.Database,
  schema: DatabaseSchema
): string[] {
  // Disable foreign keys temporarily so we can drop in any order
  db.exec("PRAGMA foreign_keys = OFF");

  // Drop all user tables (not system/internal tables)
  const rows = db
    .prepare(
      `SELECT "name" FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'`
    )
    .all() as { name: string }[];

  // Filter out internal tables (starting with _) in JS to avoid LIKE wildcard issues
  const userTables = rows.filter((r) => !r.name.startsWith("_"));

  for (const { name } of userTables) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }

  // Clear migration history
  db.exec(`DELETE FROM "${MIGRATIONS_TABLE}"`);

  // Re-enable foreign keys
  db.exec("PRAGMA foreign_keys = ON");

  // Re-run all migrations
  return runMigrations(db, schema);
}
