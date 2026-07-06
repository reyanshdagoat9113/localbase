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
import { requireAdmin, type AdminVariables } from "../auth/middleware.js";
import type { Auth } from "../auth/index.js";
import type { Scheduler } from "../jobs/scheduler.js";
import {
  assertNotSystemTable,
  assertNotVirtualTable,
  AdminError,
} from "./system-tables.js";

/**
 * Options for {@link createAdminRouter}.
 */
export interface AdminRouterOptions {
  /**
   * When set, **every** `/_api/admin/*` route is gated by `requireAdmin`.
   *
   * This is the production posture: admin auth is on, and the gate
   * re-reads the live role from `_users` on each request so a demotion
   * takes effect immediately.
   *
   * When omitted (the no-auth-mode posture), routes are served ungated.
   * The host (`createServer` / the CLI) is then responsible for
   * guaranteeing the server is bound to localhost — exposing an ungated
   * admin API on a public interface is a hard startup error there.
   */
  requireAdminSecret?: string;

  /**
   * The auth subsystem. When provided, the Auth Manager endpoints
   * (`/_api/admin/users/*`) are mounted. They go through the typed `Auth`
   * helpers so password hashing and the last-admin lockout are preserved —
   * never through the generic row endpoints, which refuse `_users` writes.
   *
   * Only mountable alongside `requireAdminSecret`: there are no users to
   * manage when auth is disabled, so `createServer` omits this in no-auth
   * mode and the user endpoints simply aren't registered.
   */
  auth?: Auth;

  /** Live scheduled-jobs registry and runner used by the Jobs viewer. */
  scheduler?: Scheduler;
}

/**
 * Hono router exposing the admin API at `/_api/admin/*`.
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
 * Invariants:
 *   - Reads are allowed on every table (including system tables).
 *   - Writes are refused on system tables (`_users`, `_sessions`, ...).
 *     Dedicated `/_api/admin/users/*` endpoints go through `Auth` and
 *     preserve password hashing / role invariants.
 *   - All mutations go through `Database.insert/update/delete`, so they
 *     emit `change` events the realtime server broadcasts for free.
 *   - Validation is against the **introspected** schema, not the
 *     declared config — admin edits validate against what the database
 *     actually has.
 *
 * Security:
 *   - When `options.requireAdminSecret` is provided, all routes are gated
 *     by `requireAdmin`, which re-verifies the caller's live `role` from
 *     `_users`. This is the only mode in which a production server should
 *     serve admin mutations.
 *   - When the secret is omitted (auth disabled), routes are ungated and
 *     the caller guarantees a localhost binding.
 */
export function createAdminRouter(
  db: Database,
  options: AdminRouterOptions = {}
): Hono<{ Variables: AdminVariables }> {
  if (options.auth && !options.requireAdminSecret) {
    throw new Error("Auth Manager routes require admin auth");
  }

  // Typed with `AdminVariables` so the user-management handlers can read the
  // admin principal that `requireAdmin` attaches (used for self-demotion
  // messaging). The variable is only populated when the gate runs, which is
  // exactly when these handlers are reachable.
  const router = new Hono<{ Variables: AdminVariables }>();

  // ── Auth gate (optional, but strongly recommended) ──
  // Applied as a wildcard middleware so it runs before every route below.
  // Per Decision #6 of the admin plan: "Never ship working admin mutations
  // without admin auth." When the secret is present, both reads AND writes
  // are gated — the schema/tables endpoints expose real data, not just
  // row counts, so they're sensitive too.
  if (options.requireAdminSecret) {
    router.use("/_api/admin/*", requireAdmin(options.requireAdminSecret, db));
  }

  // ── GET /_api/admin/schema ─────────────────────────────────
  // Introspected schema for all tables (including system tables,
  // flagged with `system: true`). Cached on the database — `db.introspect()`
  // walks the catalog each call. The admin SPA caches the result in
  // TanStack Query; we don't add server-side memoization because the
  // admin is a dev/management tool, not a hot path.
  router.get("/_api/admin/schema", (c) => {
    const schema = db.introspect();
    return c.json({
      data: {
        ...schema,
        tables: schema.tables.filter((table) => table.name !== "_admin_requests"),
      },
    });
  });

  // ── GET /_api/admin/tables ─────────────────────────────────
  // Lightweight table list — names + row counts + system flag. The
  // table browser calls this to populate the sidebar; only the active
  // table pays the cost of full schema introspection.
  router.get("/_api/admin/tables", (c) => {
    const schema = db.introspect();
    const data = schema.tables
      .filter((table) => table.name !== "_admin_requests")
      .map((t) => ({
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
    if (tableName === "_admin_requests") {
      return c.json(
        { error: "Admin requests are available only through the owner approval API" },
        403
      );
    }
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
      // so the grid's "X of Y" indicator is correct under filters. Routed
      // through Database.count (not a hand-rolled `FROM "${table}"`) so the
      // table name and every filter column are validated and values stay
      // bound — never interpolate an unchecked identifier.
      const total = db.count(tableName, filters);

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
      assertNotVirtualTable(table); // virtual tables are read-only
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
      assertNotVirtualTable(table); // virtual tables are read-only
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
      assertNotVirtualTable(table); // virtual tables are read-only
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

  // ── Auth Manager: /_api/admin/users/* ──────────────────────
  // Mounted only when an `Auth` instance is wired in. These endpoints are the
  // *only* way to mutate `_users` through the admin API — the generic row
  // endpoints refuse `_users` writes (assertNotSystemTable) precisely so that
  // password hashing and the last-admin lockout can't be bypassed. All four go
  // through the typed `Auth` methods.
  if (options.auth) {
    const auth = options.auth;

    // GET /_api/admin/users — list users, oldest first. Hashes are never
    // returned (Auth.publicUser strips them).
    router.get("/_api/admin/users", (c) => {
      return c.json({ data: auth.listUsers() });
    });

    // POST /_api/admin/users — create a user. New users are role=user; promote
    // via the role endpoint below. Matches the CLI (`createUser`) default.
    router.post("/_api/admin/users", async (c) => {
      try {
        const body = await readJson(c);
        const user = await auth.createUser(body);
        return c.json({ data: user }, 201);
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });

    // POST /_api/admin/users/:id/reset-password — set a new password.
    router.post("/_api/admin/users/:id/reset-password", async (c) => {
      try {
        const body = await readJson(c);
        await auth.setPasswordById(
          c.req.param("id"),
          body.password,
          c.get("adminUser")?.id
        );
        return c.json({ data: { success: true } });
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });

    // PATCH /_api/admin/users/:id/role — promote/demote. The actor email comes
    // from the admin principal so `setRole` can phrase the last-admin lockout
    // error for self-demotion specifically. Enforcement of the lockout is in
    // `Auth.setRole`; the UI adds a confirmation prompt for self-demotion.
    router.patch("/_api/admin/users/:id/role", async (c) => {
      try {
        const body = await readJson(c);
        const actorEmail = c.get("adminUser")?.email;
        const user = auth.setRoleById(
          c.req.param("id"),
          body.role,
          actorEmail
        );
        return c.json({ data: user });
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });

    router.get("/_api/admin/admin-requests", (c) => {
      try {
        const url = new URL(c.req.url);
        const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, 1, 100);
        const offset = parseBoundedInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        const data = auth.listAdminRequests(
          c.get("adminUser")?.role,
          limit,
          offset
        );
        return c.json({ data });
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });

    router.post("/_api/admin/admin-requests/:id/approve", (c) => {
      try {
        const user = auth.approveAdminRequest(
          c.req.param("id"),
          c.get("adminUser")?.role
        );
        return c.json({ data: user }, 201);
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });

    router.delete("/_api/admin/admin-requests/:id", (c) => {
      try {
        auth.rejectAdminRequest(c.req.param("id"), c.get("adminUser")?.role);
        return c.json({ data: { deleted: true } });
      } catch (err) {
        return adminErrorResponse(c, err);
      }
    });
  }

  // ── Scheduled Jobs: /_api/admin/jobs/* ─────────────────────
  // Only registered config names are accepted. A request parameter is never
  // interpreted as a handler path, preserving the code-execution boundary.
  if (options.scheduler) {
    const scheduler = options.scheduler;

    router.get("/_api/admin/jobs", (c) => {
      return c.json({ data: scheduler.listJobs() });
    });

    router.get("/_api/admin/jobs/:name/runs", (c) => {
      const name = c.req.param("name");
      if (!scheduler.getJob(name)) {
        return c.json({ error: `Unknown job: "${name}"` }, 404);
      }

      const url = new URL(c.req.url);
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 25, 1, 100);
      const offset = parseBoundedInteger(
        url.searchParams.get("offset"),
        0,
        0,
        Number.MAX_SAFE_INTEGER
      );
      return c.json({ data: scheduler.getRuns(name, { limit, offset }) });
    });

    router.post("/_api/admin/jobs/:name/run", (c) => {
      const name = c.req.param("name");
      if (!scheduler.getJob(name)) {
        return c.json({ error: `Unknown job: "${name}"` }, 404);
      }

      const triggered = scheduler.triggerNow(name);
      // Observe completion so a future unexpected runner rejection cannot
      // become unhandled after this request has returned.
      void triggered.completion.catch(() => {});
      if (triggered.runId === null) {
        return c.json({ error: `Job "${name}" is already running` }, 409);
      }
      return c.json({ data: { runId: triggered.runId } }, 202);
    });
  }

  return router;
}

function parseBoundedInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AdminError(400, `Invalid pagination value: "${raw}"`);
  }
  return value;
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
        if (value.trim() === "") {
          throw new AdminError(400, `Column "${column}": expected a number`);
        }
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
        if (value.trim() === "") {
          throw new AdminError(400, `Column "${column}": expected a number`);
        }
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
  // Both AdminError (query / system-table layer) and AuthError (the Auth class
  // behind the user endpoints) are HTTP-shaped errors — an Error with a
  // numeric `status`. Treat any such error as a client error so both surfaces
  // map cleanly without the router needing to know each concrete class.
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      return c.json({ error: err.message }, status as 400 | 401 | 403 | 404 | 409);
    }
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

// Re-export the config type so the host server can pass it through.
export type { AdminConfig };
