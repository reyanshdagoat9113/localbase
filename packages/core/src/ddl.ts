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
function topologicalSort(schema: DatabaseSchema): [string, TableSchema][] {
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
