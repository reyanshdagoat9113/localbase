import { Hono } from "hono";
import type { DatabaseSchema } from "@localbase/shared";
import type { Database } from "./db.js";
import type { Filter, FilterOperator, OrderBy, QueryOptions } from "./query.js";

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

// ─── Query param parsing ───────────────────────────────────────

function parseFilters(
  url: URL,
  schema: DatabaseSchema,
  tableName: string
): Filter[] {
  const table = schema[tableName];
  if (!table) return [];

  const filters: Filter[] = [];

  for (const [key, raw] of url.searchParams.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;

    // Validate column exists
    if (!(key in table)) {
      throw new HttpError(400, `Unknown column: "${key}"`);
    }

    // Parse operator.value
    const dotIndex = raw.indexOf(".");
    if (dotIndex === -1) {
      throw new HttpError(
        400,
        `Invalid filter format for "${key}". Expected "operator.value", got "${raw}"`
      );
    }

    const operator = raw.slice(0, dotIndex) as FilterOperator;
    const valueStr = raw.slice(dotIndex + 1);

    if (!VALID_OPERATORS.includes(operator)) {
      throw new HttpError(
        400,
        `Unknown operator "${operator}". Valid: ${VALID_OPERATORS.join(", ")}`
      );
    }

    let value: unknown;
    if (operator === "in") {
      // IN expects comma-separated values
      value = valueStr.split(",").map((v) => coerceValue(v, table[key].type));
    } else {
      value = coerceValue(valueStr, table[key].type);
    }

    filters.push({ column: key, operator, value });
  }

  return filters;
}

function parseOrderBy(url: URL, tableName: string, schema: DatabaseSchema): OrderBy[] {
  const orderRaw = url.searchParams.get("order");
  if (!orderRaw) return [];

  const table = schema[tableName];
  if (!table) return [];

  return orderRaw.split(",").map((part) => {
    const dotIndex = part.lastIndexOf(".");
    if (dotIndex === -1) {
      throw new HttpError(
        400,
        `Invalid order format. Expected "column.direction", got "${part}"`
      );
    }

    const column = part.slice(0, dotIndex);
    const direction = part.slice(dotIndex + 1) as "asc" | "desc";

    if (!(column in table)) {
      throw new HttpError(400, `Unknown column: "${column}"`);
    }

    if (direction !== "asc" && direction !== "desc") {
      throw new HttpError(
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
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, `Invalid limit: "${limitStr}". Must be a non-negative integer.`);
    }
    result.limit = n;
  }

  if (offsetStr !== null) {
    const n = Number(offsetStr);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, `Invalid offset: "${offsetStr}". Must be a non-negative integer.`);
    }
    result.offset = n;
  }

  return result;
}

function parseQueryOptions(
  url: URL,
  tableName: string,
  schema: DatabaseSchema
): QueryOptions {
  const filters = parseFilters(url, schema, tableName);
  const orderBy = parseOrderBy(url, tableName, schema);
  const { limit, offset } = parsePagination(url);

  return { filters, orderBy, limit, offset };
}

// ─── Value coercion ────────────────────────────────────────────

function coerceValue(
  raw: string,
  type: string
): unknown {
  switch (type) {
    case "integer":
    case "boolean": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new HttpError(400, `Expected a number, got "${raw}"`);
      }
      return type === "boolean" ? (n ? 1 : 0) : Math.trunc(n);
    }
    case "real": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new HttpError(400, `Expected a number, got "${raw}"`);
      }
      return n;
    }
    default:
      return raw; // text, blob — keep as string
  }
}

// ─── Input validation ──────────────────────────────────────────

function validateBody(
  body: Record<string, unknown>,
  schema: DatabaseSchema,
  tableName: string,
  partial = false
): Record<string, unknown> {
  const table = schema[tableName];
  if (!table) {
    throw new HttpError(400, `Unknown table: "${tableName}"`);
  }

  const validated: Record<string, unknown> = {};
  const columns = Object.keys(table);

  for (const [key, value] of Object.entries(body)) {
    if (!columns.includes(key)) {
      throw new HttpError(400, `Unknown column: "${key}"`);
    }

    const col = table[key];

    // Type check
    if (value !== null && value !== undefined) {
      validated[key] = coerceBodyValue(key, value, col.type);
    } else if (col.nullable === false && !partial) {
      throw new HttpError(400, `Column "${key}" cannot be null`);
    } else {
      validated[key] = value;
    }
  }

  // Check required columns for inserts (not partial updates)
  if (!partial) {
    for (const [colName, colDef] of Object.entries(table)) {
      if (
        colDef.nullable === false &&
        !colDef.primaryKey &&
        !colDef.autoIncrement &&
        colDef.default === undefined &&
        !(colName in body)
      ) {
        throw new HttpError(400, `Missing required column: "${colName}"`);
      }
    }
  }

  return validated;
}

function coerceBodyValue(
  column: string,
  value: unknown,
  type: string
): unknown {
  if (value === null || value === undefined) return value;

  switch (type) {
    case "integer":
    case "boolean": {
      if (typeof value === "number") return type === "boolean" ? (value ? 1 : 0) : Math.trunc(value);
      if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new HttpError(400, `Column "${column}": expected a number, got "${value}"`);
        }
        return type === "boolean" ? (n ? 1 : 0) : Math.trunc(n);
      }
      throw new HttpError(400, `Column "${column}": expected a number`);
    }
    case "real": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          throw new HttpError(400, `Column "${column}": expected a number, got "${value}"`);
        }
        return n;
      }
      throw new HttpError(400, `Column "${column}": expected a number`);
    }
    default:
      return String(value);
  }
}

// ─── HTTP Error ────────────────────────────────────────────────

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── Server factory ────────────────────────────────────────────

export function createServer(db: Database, schema: DatabaseSchema): Hono {
  const app = new Hono();

  // ── GET /api/:table — list rows ──
  app.get("/api/:table", (c) => {
    const tableName = c.req.param("table");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const url = new URL(c.req.url);
      const options = parseQueryOptions(url, tableName, schema);
      const rows = db.select(tableName, options);
      return c.json({ data: rows });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /api/:table/:id — get one row ──
  app.get("/api/:table/:id", (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    const row = db.selectById(tableName, id);
    if (!row) {
      return c.json({ error: "Row not found" }, 404);
    }

    return c.json({ data: row });
  });

  // ── POST /api/:table — insert row ──
  app.post("/api/:table", async (c) => {
    const tableName = c.req.param("table");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const body = await c.req.json();
      const validated = validateBody(body, schema, tableName);
      const result = db.insert(tableName, validated);
      return c.json({ data: result.length === 1 ? result[0] : result }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── PATCH /api/:table/:id — update row ──
  app.patch("/api/:table/:id", async (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const body = await c.req.json();
      const validated = validateBody(body, schema, tableName, true); // partial = true
      const result = db.update(tableName, validated, [
        { column: "id", operator: "eq", value: id },
      ]);

      if (result.length === 0) {
        return c.json({ error: "Row not found" }, 404);
      }

      return c.json({ data: result[0] });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── DELETE /api/:table/:id — delete row ──
  app.delete("/api/:table/:id", (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    const count = db.delete(tableName, [
      { column: "id", operator: "eq", value: id },
    ]);

    if (count === 0) {
      return c.json({ error: "Row not found" }, 404);
    }

    return c.json({ data: { deleted: true } });
  });

  // ── Health check ──
  app.get("/", (c) => c.json({ status: "ok", version: "0.1.0" }));

  return app;
}

// ─── Error handler ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(c: any, err: unknown) {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
  }

  // Catch SQLite constraint violations and return 409 Conflict
  if (err instanceof Error && "code" in err) {
    const sqliteErr = err as Error & { code: string };
    if (sqliteErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return c.json({ error: sqliteErr.message }, 409);
    }
    if (sqliteErr.code.startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: sqliteErr.message }, 400);
    }
  }

  console.error("Internal error:", err);
  return c.json({ error: "Internal server error" }, 500);
}
