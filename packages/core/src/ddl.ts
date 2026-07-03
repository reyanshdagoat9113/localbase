import type { ColumnSchema, DatabaseSchema, TableSchema } from "@localbase/shared";

/**
 * Maps our column types to SQLite column types.
 * SQLite stores booleans as INTEGER (0/1).
 */
function sqliteType(col: ColumnSchema): string {
  switch (col.type) {
    case "boolean":
      return "INTEGER";
    default:
      return col.type.toUpperCase();
  }
}

/**
 * Generates a single column definition for a CREATE TABLE statement.
 * Example output: `"email" TEXT UNIQUE NOT NULL`
 */
export function columnToDDL(name: string, col: ColumnSchema): string {
  const parts: string[] = [`"${name}"`];

  // Column type
  parts.push(sqliteType(col));

  // Primary key + autoincrement
  if (col.primaryKey) {
    parts.push("PRIMARY KEY");
    if (col.autoIncrement) {
      parts.push("AUTOINCREMENT");
    }
  }

  // NOT NULL (skip for primary keys — they're implicitly NOT NULL)
  if (!col.primaryKey && col.nullable === false) {
    parts.push("NOT NULL");
  }

  // UNIQUE
  if (col.unique) {
    parts.push("UNIQUE");
  }

  // DEFAULT
  if (col.default !== undefined) {
    parts.push(`DEFAULT ${col.default}`);
  }

  return parts.join(" ");
}

/**
 * Generates a foreign key clause for a column.
 * Example output: `FOREIGN KEY ("user_id") REFERENCES "users"("id")`
 */
export function foreignKeyClause(name: string, col: ColumnSchema): string | null {
  if (!col.references) return null;
  return `FOREIGN KEY ("${name}") REFERENCES "${col.references.table}"("${col.references.column}")`;
}

/**
 * Error thrown when an additive migration cannot be performed because the
 * column shape is unsupported by SQLite's `ALTER TABLE ADD COLUMN`.
 *
 * SQLite restrictions (https://www.sqlite.org/lang_altertable.html):
 *   - The column cannot have a PRIMARY KEY or UNIQUE constraint.
 *   - The column cannot have a foreign-key constraint.
 *   - The column cannot be `NOT NULL` unless it also has a non-NULL DEFAULT
 *     (existing rows need a value).
 *   - If the column has a `DEFAULT` of CURRENT_TIME / CURRENT_DATE /
 *     CURRENT_TIMESTAMP, the value is applied at the time of the ALTER,
 *     not per-row insert later — fine, but noted for completeness.
 *
 * These restrictions are why this function exists separately from
 * `columnToDDL`: additive changes can only express a *subset* of what a
 * fresh CREATE TABLE can. Calling this on an unsupported shape is a
 * programmer error (the declared schema asks for something SQLite can't
 * add after the fact) and should surface loudly, not silently degrade.
 */
export class AdditiveMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdditiveMigrationError";
  }
}

/**
 * Generates an `ALTER TABLE ... ADD COLUMN` statement for an additive
 * migration. Only emits the subset of column attributes SQLite allows in
 * an ADD COLUMN: type, NOT NULL (only when a DEFAULT is present), and
 * DEFAULT.
 *
 * Throws `AdditiveMigrationError` for shapes SQLite cannot add after the
 * table exists (PRIMARY KEY, UNIQUE, AUTOINCREMENT, foreign keys, NOT NULL
 * without a default). Those require table recreation, which is out of scope
 * for the additive-only migration path.
 *
 * Example output: `ALTER TABLE "_users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user'`
 */
export function columnToAddDDL(
  tableName: string,
  colName: string,
  col: ColumnSchema
): string {
  if (col.primaryKey) {
    throw new AdditiveMigrationError(
      `Cannot add column "${colName}" to "${tableName}": SQLite does not ` +
        `allow ADD COLUMN with a PRIMARY KEY constraint. Recreate the table instead.`
    );
  }
  if (col.autoIncrement) {
    throw new AdditiveMigrationError(
      `Cannot add column "${colName}" to "${tableName}": AUTOINCREMENT requires ` +
        `an INTEGER PRIMARY KEY, which cannot be added after table creation.`
    );
  }
  if (col.unique) {
    throw new AdditiveMigrationError(
      `Cannot add column "${colName}" to "${tableName}": SQLite does not ` +
        `allow ADD COLUMN with a UNIQUE constraint.`
    );
  }
  if (col.references) {
    throw new AdditiveMigrationError(
      `Cannot add column "${colName}" to "${tableName}": SQLite does not ` +
        `allow ADD COLUMN with a FOREIGN KEY constraint.`
    );
  }

  const notNull = col.nullable === false;
  if (notNull && col.default === undefined) {
    throw new AdditiveMigrationError(
      `Cannot add NOT NULL column "${colName}" to "${tableName}" without a ` +
        `DEFAULT: existing rows would have no value. Provide a default or make ` +
        `the column nullable.`
    );
  }

  const parts: string[] = [
    `ALTER TABLE "${tableName}" ADD COLUMN "${colName}"`,
    sqliteType(col),
  ];
  if (notNull) parts.push("NOT NULL");
  if (col.default !== undefined) parts.push(`DEFAULT ${col.default}`);

  return parts.join(" ");
}

/**
 * Generates a CREATE TABLE statement for a single table.
 */
export function tableToDDL(tableName: string, schema: TableSchema): string {
  const columnDefs: string[] = [];
  const foreignKeys: string[] = [];

  for (const [name, col] of Object.entries(schema)) {
    columnDefs.push(columnToDDL(name, col));

    const fk = foreignKeyClause(name, col);
    if (fk) foreignKeys.push(fk);
  }

  const allParts = [...columnDefs, ...foreignKeys];
  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${allParts.join(",\n  ")}\n);`;
}

/**
 * Compiles a full DatabaseSchema into an array of CREATE TABLE statements.
 * Tables are sorted so that referenced tables come before referencing tables
 * (topological order for foreign keys).
 */
export function schemaToDDL(schema: DatabaseSchema): string[] {
  const sorted = topologicalSort(schema);
  return sorted.map(([name, table]) => tableToDDL(name, table));
}

/**
 * Sorts tables so that any table referenced via foreign keys is created before
 * the table that references it. Throws on circular dependencies.
 */
export function topologicalSort(schema: DatabaseSchema): [string, TableSchema][] {
  const tableNames = Object.keys(schema);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: [string, TableSchema][] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular foreign key dependency detected involving table "${name}"`);
    }
    visiting.add(name);

    const table = schema[name];
    if (!table) {
      throw new Error(`Referenced table "${name}" not found in schema`);
    }

    // Visit dependencies first
    for (const col of Object.values(table)) {
      if (col.references) {
        visit(col.references.table);
      }
    }

    visiting.delete(name);
    visited.add(name);
    result.push([name, table]);
  }

  for (const name of tableNames) {
    visit(name);
  }

  return result;
}
