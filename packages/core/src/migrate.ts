import type { DatabaseSchema } from "@localbase/shared";
import type { DbDriver } from "./db/index.js";
import {
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
async function ensureMigrationsTable(driver: DbDriver): Promise<void> {
  await driver.execBatch(driver.dialect.migrationsTableDDL(MIGRATIONS_TABLE));
}

/**
 * Returns the set of migration names that have already been applied.
 */
export async function getAppliedMigrations(driver: DbDriver): Promise<Set<string>> {
  await ensureMigrationsTable(driver);
  const rows = await driver.query<{ name: string }>(
    `SELECT "name" FROM "${MIGRATIONS_TABLE}"`
  );
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
 *
 * Returns the list of newly applied migration names.
 */
export async function runMigrations(
  driver: DbDriver,
  schema: DatabaseSchema
): Promise<string[]> {
  await ensureMigrationsTable(driver);
  const applied = await getAppliedMigrations(driver);
  const sortedEntries = topologicalSort(schema);
  const appliedNames: string[] = [];

  try {
    await driver.transaction(async (tx) => {
      // ── Phase 1: create new tables (referenced tables first) ──
      for (const [name, tableSchema] of sortedEntries) {
        if (applied.has(name)) continue;

        await tx.execBatch(tableToDDL(name, tableSchema, driver.dialect));
        await tx.execute(
          `INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES (${driver.dialect.placeholder(1)})`,
          [name]
        );

        applied.add(name);
        appliedNames.push(name);
      }

      // ── Phase 2: add missing columns to existing tables (additive) ──
      for (const [tableName, tableSchema] of sortedEntries) {
        if (!applied.has(tableName)) continue;

        const present = await driver.existingColumns(tableName);
        for (const [colName, colDef] of Object.entries(tableSchema)) {
          if (present.has(colName)) continue;

          const migrationKey = `${tableName}${COLUMN_MIGRATION_SEPARATOR}${colName}`;
          if (applied.has(migrationKey)) continue;

          const ddl = columnToAddDDL(tableName, colName, colDef, driver.dialect);
          await tx.execBatch(ddl);
          await tx.execute(
            `INSERT INTO "${MIGRATIONS_TABLE}" ("name") VALUES (${driver.dialect.placeholder(1)})`,
            [migrationKey]
          );

          applied.add(migrationKey);
          appliedNames.push(migrationKey);
        }
      }
    });
  } catch (err) {
    if (err instanceof AdditiveMigrationError) throw err;
    throw err;
  }

  return appliedNames;
}

/**
 * Drops all user tables and re-runs migrations.
 * Useful for `localbase db reset`.
 */
export async function resetDatabase(
  driver: DbDriver,
  schema: DatabaseSchema
): Promise<string[]> {
  const userTables = await driver.listUserTables();
  await driver.dropTablesForReset(userTables);

  // Clear migration history only for the user tables we actually dropped.
  // System tables (prefixed with `_`) are preserved.
  await ensureMigrationsTable(driver);
  for (const name of userTables) {
    await driver.execute(
      `DELETE FROM "${MIGRATIONS_TABLE}" WHERE "name" = ${driver.dialect.placeholder(1)} OR "name" LIKE ${driver.dialect.placeholder(2)}`,
      [name, `${name}${COLUMN_MIGRATION_SEPARATOR}%`]
    );
  }

  return runMigrations(driver, schema);
}
