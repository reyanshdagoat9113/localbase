import type Database from "better-sqlite3";

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
    throw new Error(`Invalid column name: "${name}"`);
  }
}

function assertSafeTable(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name: "${name}"`);
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
        throw new Error(`"in" operator requires an array value`);
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
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;

  const stmt = db.prepare(sql);
  const inserted: unknown[] = [];

  const runInsert = db.transaction(() => {
    for (const row of rows) {
      const info = stmt.run(row);
      // Fetch the inserted row by its last insert rowid
      const insertedRow = db
        .prepare(`SELECT * FROM "${table}" WHERE "id" = ?`)
        .get(info.lastInsertRowid);
      inserted.push(insertedRow);
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
 * Returns the count of deleted rows.
 */
export function remove(
  db: Database.Database,
  table: string,
  filters: Filter[] = []
): number {
  assertSafeTable(table);

  const { clause, params } = buildWhereClause(filters);
  const sql = `DELETE FROM "${table}" ${clause}`;
  const info = db.prepare(sql).run(params);
  return info.changes;
}
