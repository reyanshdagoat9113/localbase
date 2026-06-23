import type Database from "better-sqlite3";
import type { DatabaseSchema } from "@localbase/shared";
import {
  schemaToDDL,
  tableToDDL,
  topologicalSort,
  columnToAddDDL,
  AdditiveMigrationError,
} from "./ddl.js";

const MIGRATIONS_TABLE = "_migrations";

/**
 * Separator used in column-level migration names: `<table>::<column>`.
 * Chosen because `::` cannot appear in a SQL identifier, so there's no
 * collision risk with real table or column names.
 */
const COLUMN_MIGRATION_SEPARATOR = "::";

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
 * Returns the names of columns currently present on a table, by introspecting
 * `sqlite_master` metadata (via PRAGMA table_info). Used by the additive
 * migration pass to decide which declared columns still need ADD COLUMN.
 */
function existingColumns(
  db: Database.Database,
  table: string
): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Runs pending migrations for the given schema.
 *
 * Two phases, both inside a single transaction:
 *
 *   Phase 1 — CREATE: for each table not yet recorded in `_migrations`,
 *            run its `CREATE TABLE` and record the table name.
 *
 *   Phase 2 — ADD COLUMN (additive): for each table that already exists,
 *            compare declared columns against the columns the DB actually
 *            has. For every declared column missing from the DB, run
 *            `ALTER TABLE ... ADD COLUMN` and record `<table>::<column>`.
 *            This is how a new column on an existing table (e.g. `role` on
 *            `_users`) lands without dropping or recreating the table.
 *
 * Non-additive changes (dropping a column, changing a type, adding a
 * PRIMARY KEY / UNIQUE / FK to an existing table) are NOT supported and
 * will throw — they require table recreation, which is intentionally out
 * of scope. Config-first philosophy: change the schema, then reset in dev.
 *
 * Returns the list of newly applied migration names.
 */
export function runMigrations(
  db: Database.Database,
  schema: DatabaseSchema
): string[] {
  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);

  // Sort once so that the CREATE order (referenced tables first) is the same
  // order we iterate in both phases. Iterating the sorted entries directly
  // (rather than indexing Object.keys against schemaToDDL's output) keeps
  // each migration name aligned with the DDL that was actually run.
  const sortedEntries = topologicalSort(schema);
  const appliedNames: string[] = [];

  const migrate = db.transaction(() => {
    // ── Phase 1: create new tables (referenced tables first) ──
    for (const [name, tableSchema] of sortedEntries) {
      if (applied.has(name)) continue;

      db.exec(tableToDDL(name, tableSchema));

      db.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES (?)`
      ).run(name);

      applied.add(name);
      appliedNames.push(name);
    }

    // ── Phase 2: add missing columns to existing tables (additive) ──
    for (const [tableName, tableSchema] of sortedEntries) {
      if (!applied.has(tableName)) continue; // created in phase 1 — already current

      const present = existingColumns(db, tableName);
      for (const [colName, colDef] of Object.entries(tableSchema)) {
        if (present.has(colName)) continue;

        const migrationKey = `${tableName}${COLUMN_MIGRATION_SEPARATOR}${colName}`;
        if (applied.has(migrationKey)) continue; // defensive — shouldn't happen

        const ddl = columnToAddDDL(tableName, colName, colDef);
        db.exec(ddl);

        db.prepare(
          `INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES (?)`
        ).run(migrationKey);

        applied.add(migrationKey);
        appliedNames.push(migrationKey);
      }
    }
  });

  try {
    migrate();
  } catch (err) {
    // Surface additive-migration programmer errors with their clear message
    // rather than wrapping them in a generic transaction failure.
    if (err instanceof AdditiveMigrationError) throw err;
    throw err;
  }
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

  // Clear migration history only for the user tables we actually dropped.
  // System tables (auth/storage/etc., prefixed with `_`) are intentionally
  // preserved above, so their migration records must be preserved too;
  // otherwise the next migrate would try to CREATE already-existing tables.
  for (const { name } of userTables) {
    db.prepare(
      `DELETE FROM "${MIGRATIONS_TABLE}" WHERE "name" = ? OR "name" LIKE ?`
    ).run(name, `${name}${COLUMN_MIGRATION_SEPARATOR}%`);
  }

  // Re-enable foreign keys
  db.exec("PRAGMA foreign_keys = ON");

  // Re-run all migrations
  return runMigrations(db, schema);
}
