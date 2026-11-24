import { AdminError } from "./admin/system-tables.js";
import type { DbDriver, QueryExecutor, SqlDialect } from "./db/index.js";

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
  filters: Filter[],
  dialect: SqlDialect,
  startIndex = 1
): { clause: string; params: unknown[]; nextIndex: number } {
  if (filters.length === 0) {
    return { clause: "", params: [], nextIndex: startIndex };
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  for (const f of filters) {
    assertSafeColumn(f.column);

    if (f.operator === "in") {
      if (!Array.isArray(f.value)) {
        throw new AdminError(400, `"in" operator requires an array value`);
      }
      if (f.value.length === 0) {
        conditions.push("1 = 0");
      } else {
        const placeholders: string[] = [];
        for (const v of f.value) {
          placeholders.push(dialect.placeholder(idx++));
          params.push(v);
        }
        conditions.push(`"${f.column}" IN (${placeholders.join(", ")})`);
      }
    } else {
      conditions.push(`"${f.column}" ${OP_MAP[f.operator]} ${dialect.placeholder(idx++)}`);
      params.push(f.value);
    }
  }

  return {
    clause: `WHERE ${conditions.join(" AND ")}`,
    params,
    nextIndex: idx,
  };
}

// ─── CRUD Operations ──────────────────────────────────────────

/**
 * SELECT rows from a table with optional filters, ordering, and pagination.
 */
export async function select(
  db: QueryExecutor,
  table: string,
  options: QueryOptions = {}
): Promise<unknown[]> {
  assertSafeTable(table);

  const { filters = [], orderBy = [], limit, offset } = options;
  const { clause, params, nextIndex } = buildWhereClause(filters, db.dialect, 1);
  let idx = nextIndex;
  const allParams = [...params];

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
    sql += ` LIMIT ${db.dialect.placeholder(idx++)}`;
    allParams.push(limit);
  }
  if (offset !== undefined) {
    sql += ` OFFSET ${db.dialect.placeholder(idx++)}`;
    allParams.push(offset);
  }

  return db.query(sql, allParams);
}

/**
 * COUNT rows in a table, optionally filtered by the SAME WHERE clause
 * {@link select} uses. Coerces `COUNT(*)` to a JS number (Postgres returns
 * `bigint` as a string).
 */
export async function count(
  db: QueryExecutor,
  table: string,
  filters: Filter[] = []
): Promise<number> {
  assertSafeTable(table);
  const { clause, params } = buildWhereClause(filters, db.dialect, 1);
  const row = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM "${table}" ${clause}`,
    params
  );
  return Number(row?.n ?? 0);
}

/**
 * SELECT a single row by primary key (id).
 */
export async function selectById(
  db: QueryExecutor,
  table: string,
  id: number | string
): Promise<unknown | undefined> {
  assertSafeTable(table);
  return db.queryOne(
    `SELECT * FROM "${table}" WHERE "id" = ${db.dialect.placeholder(1)}`,
    [id]
  );
}

/**
 * INSERT one or more rows into a table.
 * Returns the inserted row(s) with their generated id.
 */
export async function insert(
  db: DbDriver | QueryExecutor,
  table: string,
  data: Record<string, unknown> | Record<string, unknown>[]
): Promise<unknown[]> {
  assertSafeTable(table);

  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];

  const columns = Object.keys(rows[0]);
  columns.forEach(assertSafeColumn);

  const colList = columns.map((c) => `"${c}"`).join(", ");
  const placeholders = columns
    .map((_, i) => db.dialect.placeholder(i + 1))
    .join(", ");
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) RETURNING *`;

  const runInserts = async (exec: QueryExecutor): Promise<unknown[]> => {
    const inserted: unknown[] = [];
    for (const row of rows) {
      const values = columns.map((c) => row[c]);
      const result = await exec.queryOne(sql, values);
      inserted.push(result);
    }
    return inserted;
  };

  if (rows.length > 1 && "transaction" in db && typeof db.transaction === "function") {
    return db.transaction(runInserts);
  }
  return runInserts(db);
}

/**
 * UPDATE rows in a table matching the given filters.
 * Returns the updated row(s).
 */
export async function update(
  db: QueryExecutor,
  table: string,
  data: Record<string, unknown>,
  filters: Filter[] = []
): Promise<unknown[]> {
  assertSafeTable(table);

  const columns = Object.keys(data);
  columns.forEach(assertSafeColumn);

  let idx = 1;
  const setParams: unknown[] = [];
  const setParts = columns.map((c) => {
    setParams.push(data[c]);
    return `"${c}" = ${db.dialect.placeholder(idx++)}`;
  });
  const setClause = `SET ${setParts.join(", ")}`;

  const { clause: whereClause, params: whereParams } = buildWhereClause(
    filters,
    db.dialect,
    idx
  );

  const sql = `UPDATE "${table}" ${setClause} ${whereClause} RETURNING *`;
  return db.query(sql, [...setParams, ...whereParams]);
}

/**
 * DELETE rows from a table matching the given filters.
 * Returns the deleted rows.
 */
export async function remove(
  db: QueryExecutor,
  table: string,
  filters: Filter[] = []
): Promise<unknown[]> {
  assertSafeTable(table);

  const { clause, params } = buildWhereClause(filters, db.dialect, 1);
  const sql = `DELETE FROM "${table}" ${clause} RETURNING *`;
  return db.query(sql, params);
}
