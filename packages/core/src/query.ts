import type Database from "better-sqlite3";
import { AdminError } from "./admin/system-tables.js";

// ─── Filter types ──────────────────────────────────────────────

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "like"
  | "in";

export interface Filter {
  column: string;
  operator: FilterOperator;
  value: unknown;
}

export interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

export interface QueryOptions {
  filters?: Filter[];
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
}

// ─── Helpers ───────────────────────────────────────────────────

function assertSafeColumn(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    // Throwing AdminError (not a plain Error) lets both the admin router's
    // adminErrorResponse and the public-API handleError map this to a clean
    // 400. A plain Error would surface as a 500 + stderr stack trace — the
    // single source of truth for identifier validity should fail loudly but
    // politely. See the admin plan: "Identifier quoting must be centralized."
    throw new AdminError(400, `Invalid column name: "${name}"`);
  }
}

function assertSafeTable(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new AdminError(400, `Invalid table name: "${name}"`);
  }
}

const OP_MAP: Record<FilterOperator, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  like: "LIKE",
  in: "IN",
};

function buildWhereClause(
  filters: Filter[]
): { clause: string; params: Record<string, unknown> } {
  if (filters.length === 0) return { clause: "", params: {} };

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    assertSafeColumn(f.column);
    const paramKey = `__f${i}`;

    if (f.operator === "in") {
      // IN requires an array
      if (!Array.isArray(f.value)) {
        throw new AdminError(400, `"in" operator requires an array value`);
      }
      const placeholders = f.value.map((_, j) => `@${paramKey}_${j}`);
      conditions.push(`"${f.column}" IN (${placeholders.join(", ")})`);
      f.value.forEach((v: unknown, j: number) => {
        params[`${paramKey}_${j}`] = v;
      });
    } else {
      conditions.push(`"${f.column}" ${OP_MAP[f.operator]} @${paramKey}`);
      params[paramKey] = f.value;
    }
  }

  return {
    clause: `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

// ─── CRUD Operations ──────────────────────────────────────────

/**
 * SELECT rows from a table with optional filters, ordering, and pagination.
 */
export function select(
  db: Database.Database,
  table: string,
  options: QueryOptions = {}
): unknown[] {
  assertSafeTable(table);

  const { filters = [], orderBy = [], limit, offset } = options;
  const { clause, params } = buildWhereClause(filters);

  let sql = `SELECT * FROM "${table}"`;

  if (clause) sql += ` ${clause}`;

  if (orderBy.length > 0) {
    const orderParts = orderBy.map((o) => {
      assertSafeColumn(o.column);
      return `"${o.column}" ${o.direction.toUpperCase()}`;
    });
    sql += ` ORDER BY ${orderParts.join(", ")}`;
  }

  if (limit !== undefined) {
    sql += ` LIMIT @__limit`;
  }
  if (offset !== undefined) {
    sql += ` OFFSET @__offset`;
  }

  const allParams: Record<string, unknown> = { ...params };
  if (limit !== undefined) allParams.__limit = limit;
  if (offset !== undefined) allParams.__offset = offset;

  return db.prepare(sql).all(allParams);
}

/**
 * COUNT rows in a table, optionally filtered by the SAME WHERE clause
 * {@link select} uses. Centralizing this here (rather than each caller
 * string-interpolating `FROM "<table>"`) guarantees the table name and every
 * filter column pass through {@link assertSafeTable}/{@link assertSafeColumn}
 * and that filter values stay bound parameters. The admin rows endpoint uses
 * this to compute the unfiltered-by-LIMIT total for its `X of Y` indicator.
 */
export function count(
  db: Database.Database,
  table: string,
  filters: Filter[] = []
): number {
  assertSafeTable(table);
  const { clause, params } = buildWhereClause(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM "${table}" ${clause}`)
    .get(params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * SELECT a single row by primary key (id).
 */
export function selectById(
  db: Database.Database,
  table: string,
  id: number | string
): unknown | undefined {
  assertSafeTable(table);
  return db.prepare(`SELECT * FROM "${table}" WHERE "id" = ?`).get(id);
}

/**
 * INSERT one or more rows into a table.
 * Returns the inserted row(s) with their generated id.
 */
export function insert(
  db: Database.Database,
  table: string,
  data: Record<string, unknown> | Record<string, unknown>[]
): unknown[] {
  assertSafeTable(table);

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];

  // Use the keys from the first row as column set
  const columns = Object.keys(rows[0]);
  columns.forEach(assertSafeColumn);

  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns.map((c) => `@${c}`).join(", ");
  // RETURNING * fetches the inserted row in the same statement, which is
  // correct for EVERY table shape: ordinary rowid tables, no-PK tables,
  // composite-PK tables, single text/integer-PK tables, AND WITHOUT ROWID
  // tables (which have no `rowid`, so a `WHERE rowid = lastInsertRowid`
  // refetch would throw "no such column: rowid"). SQLite >= 3.35 supports
  // RETURNING; better-sqlite3 returns the rows via .get()/.all().
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) RETURNING *`;

  // For INSERT...RETURNING, .get() returns the returned row and still throws
  // on a constraint violation (rolling back the surrounding transaction).
  const stmt = db.prepare(sql);
  const inserted: unknown[] = [];

  const runInsert = db.transaction(() => {
    for (const row of rows) {
      inserted.push(stmt.get(row));
    }
  });

  runInsert();
  return inserted;
}

/**
 * UPDATE rows in a table matching the given filters.
 * Returns the updated row(s).
 */
export function update(
  db: Database.Database,
  table: string,
  data: Record<string, unknown>,
  filters: Filter[] = []
): unknown[] {
  assertSafeTable(table);

  const columns = Object.keys(data);
  columns.forEach(assertSafeColumn);

  const setParts = columns.map((c) => `"${c}" = @__set_${c}`);
  const setClause = `SET ${setParts.join(", ")}`;

  const setParams: Record<string, unknown> = {};
  for (const c of columns) {
    setParams[`__set_${c}`] = data[c];
  }

  const { clause: whereClause, params: whereParams } =
    buildWhereClause(filters);

  // Use RETURNING to get the updated rows (filters may reference columns being updated)
  const sql = `UPDATE "${table}" ${setClause} ${whereClause} RETURNING *`;
  return db.prepare(sql).all({ ...setParams, ...whereParams });
}

/**
 * DELETE rows from a table matching the given filters.
 * Returns the deleted rows.
 */
export function remove(
  db: Database.Database,
  table: string,
  filters: Filter[] = []
): unknown[] {
  assertSafeTable(table);

  const { clause, params } = buildWhereClause(filters);
  const sql = `DELETE FROM "${table}" ${clause} RETURNING *`;
  return db.prepare(sql).all(params) as unknown[];
}
