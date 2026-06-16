import { Hono } from "hono";
import type {
  AdminConfig,
  IntrospectedColumn,
  IntrospectedTable,
} from "@localbase/shared";
import type { Database } from "../db.js";
import {
  select,
  type Filter,
  type FilterOperator,
  type OrderBy,
} from "../query.js";
import {
  assertNotSystemTable,
  AdminError,
} from "./system-tables.js";

/**
 * Hono router exposing the M1 admin API at `/_api/admin/*`.
 *
 * Endpoints (all paths absolute — the host mounts this at root with
 * `app.route("/", createAdminRouter(...))`):
 *
 *   GET    /_api/admin/schema          → full introspected schema
 *   GET    /_api/admin/tables          → list of table names + row counts
 *   GET    /_api/admin/tables/:t/rows  → paginated/sorted/filtered rows
 *   POST   /_api/admin/tables/:t/rows  → insert row (through Database)
 *   PATCH  /_api/admin/tables/:t/rows/:id → update row (through Database)
 *   DELETE /_api/admin/tables/:t/rows/:id → delete row (through Database)
 *
 * M1 invariants:
 *   - Reads are allowed on every table (including system tables).
 *   - Writes are refused on system tables (`_users`, `_sessions`, ...).
 *     M5 will add dedicated `/_api/admin/users/*` endpoints that go
 *     through `Auth` and preserve password hashing / role invariants.
 *   - All mutations go through `Database.insert/update/delete`, so they
 *     emit `change` events the realtime server broadcasts for free.
 *   - Validation is against the **introspected** schema, not the
 *     declared config — admin edits validate against what the database
 *     actually has, so a user who ran a raw SQL migration gets
 *     schema-truth in the editor.
 *
 * M1 security:
 *   - No auth gate. The `requireAdmin` middleware is M2's job. Until
 *     then, `createServer` logs a startup warning and recommends
 *     binding to `127.0.0.1`.
 */
export function createAdminRouter(db: Database): Hono {
  const router = new Hono();

  // ── GET /_api/admin/schema ─────────────────────────────────
  // Introspected schema for all tables (including system tables,
  // flagged with `system: true`). Cached on the database — `db.introspect()`
  // walks the catalog each call. The admin SPA caches the result in
  // TanStack Query; we don't add server-side memoization because the
  // admin is a dev/management tool, not a hot path.
  router.get("/_api/admin/schema", (c) => {
    return c.json({ data: db.introspect() });
  });

  // ── GET /_api/admin/tables ─────────────────────────────────
  // Lightweight table list — names + row counts + system flag. The
  // table browser calls this to populate the sidebar; only the active
  // table pays the cost of full schema introspection.
  router.get("/_api/admin/tables", (c) => {
    const schema = db.introspect();
    const data = schema.tables.map((t) => ({
      name: t.name,
      rowCount: t.rowCount,
      system: t.system,
    }));
    return c.json({ data });
  });

  // ── GET /_api/admin/tables/:table/rows ─────────────────────
  // Paginated, sorted, filtered rows. Returns `{ rows, total }` so the
  // grid can show "showing 1–25 of 137" without an extra request.
  router.get("/_api/admin/tables/:table/rows", (c) => {
    const tableName = c.req.param("table");
    if (!tableExists(db, tableName)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const table = findTable(db, tableName);
      const url = new URL(c.req.url);
      const { limit, offset } = parsePagination(url);
      const orderBy = parseOrderBy(url, table);
      const filters = parseFilters(url, table);

      // Total count is computed with the same WHERE clause (no LIMIT)
      // so the grid's "X of Y" indicator is correct under filters.
      const { clause, params } = buildWhere(filters);
      const totalRow = db
        .raw()
        .prepare(
          `SELECT COUNT(*) AS n FROM "${tableName}" ${clause}`
        )
        .get(params) as { n: number } | undefined;
      const total = totalRow?.n ?? 0;

      const rows = select(
        db.raw(),
        tableName,
        { filters, orderBy, limit, offset }
      );

      return c.json({ data: { rows, total } });
    } catch (err) {
      return adminErrorResponse(c, err);
    }
  });

  // ── POST /_api/admin/tables/:table/rows ────────────────────
  router.post("/_api/admin/tables/:table/rows", async (c) => {
    const tableName = c.req.param("table");
    if (!tableExists(db, tableName)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      assertNotSystemTable(tableName); // security gate
      const body = await readJson(c);
      const table = findTable(db, tableName);
      const validated = validateBody(body, table, false);
      const inserted = db.insert(tableName, validated);
      return c.json({ data: inserted[0] ?? null }, 201);
    } catch (err) {
      return adminErrorResponse(c, err);
    }
  });

  // ── PATCH /_api/admin/tables/:table/rows/:id ───────────────
  router.patch("/_api/admin/tables/:table/rows/:id", async (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");
    if (!tableExists(db, tableName)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      assertNotSystemTable(tableName); // security gate
      const body = await readJson(c);
      const table = findTable(db, tableName);
      const validated = validateBody(body, table, true);
      const pkCol = getSinglePrimaryKey(table);
      const result = db.update(
        tableName,
        validated,
        [{ column: pkCol, operator: "eq", value: id }]
      );
      if (result.length === 0) {
        return c.json({ error: "Row not found" }, 404);
      }
      return c.json({ data: result[0] });
    } catch (err) {
      return adminErrorResponse(c, err);
    }
  });

  // ── DELETE /_api/admin/tables/:table/rows/:id ──────────────
  router.delete("/_api/admin/tables/:table/rows/:id", (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");
    if (!tableExists(db, tableName)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      assertNotSystemTable(tableName); // security gate
      const table = findTable(db, tableName);
      const pkCol = getSinglePrimaryKey(table);
      const count = db.delete(tableName, [
        { column: pkCol, operator: "eq", value: id },
      ]);
      if (count === 0) {
        return c.json({ error: "Row not found" }, 404);
      }
      return c.json({ data: { deleted: true } });
    } catch (err) {
      return adminErrorResponse(c, err);
    }
  });

  return router;
}

// ─── Query param parsing ──────────────────────────────────────
//
// The public CRUD API in api.ts has a more elaborate filter parser (it's
// the public contract). For the admin we want the same operator vocabulary
// (eq, neq, gt, lt, gte, lte, like, in) but we lean on the **introspected**
// schema, not the declared one. That way if a user added a column with a
// raw migration, the admin will accept filters on it.

const RESERVED_PARAMS = new Set(["order", "limit", "offset"]);
const VALID_OPERATORS: FilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "like",
  "in",
];

function parseFilters(url: URL, table: IntrospectedTable): Filter[] {
  const filters: Filter[] = [];
  for (const [key, raw] of url.searchParams.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (!table.columns.find((c) => c.name === key)) {
      throw new AdminError(400, `Unknown column: "${key}"`);
    }
    const dotIndex = raw.indexOf(".");
    if (dotIndex === -1) {
      throw new AdminError(
        400,
        `Invalid filter format for "${key}". Expected "operator.value", got "${raw}"`
      );
    }
    const operator = raw.slice(0, dotIndex) as FilterOperator;
    if (!VALID_OPERATORS.includes(operator)) {
      throw new AdminError(
        400,
        `Unknown operator "${operator}". Valid: ${VALID_OPERATORS.join(", ")}`
      );
    }
    const valueStr = raw.slice(dotIndex + 1);
    let value: unknown;
    if (operator === "in") {
      value = valueStr.split(",");
    } else {
      value = valueStr;
    }
    filters.push({ column: key, operator, value });
  }
  return filters;
}

function parseOrderBy(url: URL, table: IntrospectedTable): OrderBy[] {
  const orderRaw = url.searchParams.get("order");
  if (!orderRaw) return [];
  return orderRaw.split(",").map((part) => {
    const dotIndex = part.lastIndexOf(".");
    if (dotIndex === -1) {
      throw new AdminError(
        400,
        `Invalid order format. Expected "column.direction", got "${part}"`
      );
    }
    const column = part.slice(0, dotIndex);
    const direction = part.slice(dotIndex + 1) as "asc" | "desc";
    if (!table.columns.find((c) => c.name === column)) {
      throw new AdminError(400, `Unknown column: "${column}"`);
    }
    if (direction !== "asc" && direction !== "desc") {
      throw new AdminError(
        400,
        `Invalid sort direction "${direction}". Use "asc" or "desc"`
      );
    }
    return { column, direction };
  });
}

function parsePagination(url: URL): { limit?: number; offset?: number } {
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");
  const result: { limit?: number; offset?: number } = {};
  if (limitStr !== null) {
    const n = Number(limitStr);
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      throw new AdminError(
        400,
        `Invalid limit: "${limitStr}". Must be an integer between 0 and 1000.`
      );
    }
    result.limit = n;
  }
  if (offsetStr !== null) {
    const n = Number(offsetStr);
    if (!Number.isInteger(n) || n < 0) {
      throw new AdminError(
        400,
        `Invalid offset: "${offsetStr}". Must be a non-negative integer.`
      );
    }
    result.offset = n;
    if (result.limit === undefined) {
      throw new AdminError(400, "offset requires limit");
    }
  }
  return result;
}

// ─── Body validation (introspected) ───────────────────────────
//
// Like the public CRUD validator in api.ts, but driven by the actual
// DB schema (not the declared config) and without the secondary
// required-column check (introspected columns don't tell us which
// are "required by the user" — we use SQLite's NOT NULL flag instead).

function validateBody(
  body: Record<string, unknown>,
  table: IntrospectedTable,
  partial: boolean
): Record<string, unknown> {
  const colMap = new Map(table.columns.map((c) => [c.name, c]));
  const validated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    const col = colMap.get(key);
    if (!col) {
      throw new AdminError(400, `Unknown column: "${key}"`);
    }
    if (value === null) {
      if (col.notNull && !col.primaryKey) {
        throw new AdminError(400, `Column "${key}" cannot be null`);
      }
      validated[key] = null;
      continue;
    }
    validated[key] = coerceBodyValue(key, value, col);
  }

  if (partial && Object.keys(validated).length === 0) {
    throw new AdminError(400, "Request body must include at least one column");
  }

  if (!partial) {
    for (const col of table.columns) {
      if (col.primaryKey && col.autoIncrement) continue; // autogenerated
      if (!col.notNull) continue; // nullable, or has a default
      if (col.defaultValue !== null) continue; // DB will fill in
      if (!(col.name in validated)) {
        throw new AdminError(
          400,
          `Missing required column: "${col.name}"`
        );
      }
    }
  }

  return validated;
}

function coerceBodyValue(
  column: string,
  value: unknown,
  col: IntrospectedColumn
): unknown {
  switch (col.type) {
    case "INTEGER":
    case "BIGINT": {
      if (typeof value === "number") return Math.trunc(value);
      if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new AdminError(
            400,
            `Column "${column}": expected a number, got "${value}"`
          );
        }
        return Math.trunc(n);
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      throw new AdminError(400, `Column "${column}": expected a number`);
    }
    case "REAL": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new AdminError(
            400,
            `Column "${column}": expected a number, got "${value}"`
          );
        }
        return n;
      }
      throw new AdminError(400, `Column "${column}": expected a number`);
    }
    default:
      return String(value);
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function tableExists(db: Database, name: string): boolean {
  return db
    .raw()
    .prepare(
      `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(name) !== undefined;
}

function findTable(db: Database, name: string): IntrospectedTable {
  const schema = db.introspect();
  const t = schema.tables.find((t) => t.name === name);
  if (!t) {
    throw new AdminError(404, `Unknown table: "${name}"`);
  }
  return t;
}

function getSinglePrimaryKey(table: IntrospectedTable): string {
  if (table.primaryKey.length !== 1) {
    throw new AdminError(
      400,
      `Table "${table.name}" must have exactly one primary key column to use this row endpoint.`
    );
  }
  return table.primaryKey[0];
}

async function readJson(
  c: { req: { json: () => Promise<unknown> } }
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AdminError(400, "Invalid or missing JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminError(400, "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function adminErrorResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  err: unknown
) {
  if (err instanceof AdminError) {
    return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409);
  }
  if (err instanceof Error && "code" in err) {
    const sqliteErr = err as Error & { code: string };
    if (sqliteErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return c.json({ error: sqliteErr.message }, 409);
    }
    if (sqliteErr.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return c.json(
        { error: "Foreign key constraint failed." },
        409
      );
    }
    if (sqliteErr.code.startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: sqliteErr.message }, 400);
    }
  }
  console.error("Admin error:", err);
  return c.json({ error: "Internal server error" }, 500);
}

// Filter helpers used to run a COUNT(*) with the same WHERE clause that
// powers the filtered rows endpoint. We could expose `buildWhereClause`
// from query.ts, but keeping it local lets the admin evolve independently
// of the public CRUD API.
function buildWhere(
  filters: Filter[]
): { clause: string; params: Record<string, unknown> } {
  if (filters.length === 0) return { clause: "", params: {} };
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f.operator === "in") {
      if (!Array.isArray(f.value)) {
        throw new AdminError(400, `"in" operator requires an array value`);
      }
      const placeholders = f.value
        .map((_, j) => `@__a${i}_${j}`)
        .join(", ");
      parts.push(`"${f.column}" IN (${placeholders})`);
      f.value.forEach((v, j) => {
        params[`__a${i}_${j}`] = v;
      });
    } else {
      parts.push(`"${f.column}" ${opSql(f.operator)} @__a${i}`);
      params[`__a${i}`] = f.value;
    }
  }
  return { clause: `WHERE ${parts.join(" AND ")}`, params };
}

function opSql(op: FilterOperator): string {
  switch (op) {
    case "eq": return "=";
    case "neq": return "!=";
    case "gt": return ">";
    case "lt": return "<";
    case "gte": return ">=";
    case "lte": return "<=";
    case "like": return "LIKE";
    case "in": return "IN";
  }
}

// Re-export the config type so the host server can pass it through.
export type { AdminConfig };
