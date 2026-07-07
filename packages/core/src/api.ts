import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type {
  AdminConfig,
  AuthConfig,
  DatabaseSchema,
  PoliciesConfig,
  SecurityConfig,
} from "@localbase/shared";
import type { Database } from "./db.js";
import type { Filter, FilterOperator, OrderBy, QueryOptions } from "./query.js";
import {
  Auth,
  createAuthRouter,
  resolveAuthConfig,
  authenticate,
} from "./auth/index.js";
import { resolvePolicies, ownerFilter, stampOwner, liveAdminRole } from "./rls.js";
import { createAdminRouter } from "./admin/router.js";
import { mountAdminStatic } from "./admin/static.js";
import { AdminError } from "./admin/system-tables.js";
import { createStorageRouter, type StorageRouterOptions } from "./storage/router.js";
import type { Scheduler } from "./jobs/scheduler.js";
import { rateLimit } from "./rate-limit.js";

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

// ─── Security middleware (NET-P0) ──────────────────────────────
//
// These helpers turn a `SecurityConfig` into the global middlewares mounted
// by `createServer`: configurable CORS (loopback-safe by default), consistent
// security headers, and a bounded request-body size. Rate limiting is wired
// separately because it targets specific abuse-sensitive routes, not every
// request.

/**
 * Default max size for a JSON request body on the public/admin API. ~1 MiB is
 * generous for auth payloads and row edits while capping a single request's
 * memory footprint. Storage uploads are exempt — they enforce their own
 * `storage.maxFileSize`.
 */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Default response headers applied to every response. These are baseline
 * browser-protection headers; `security.headers.extra` can add more or
 * override any of them by name.
 */
const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/**
 * True when `origin` is a loopback origin: `http(s)://localhost` or
 * `http(s)://127.0.0.1`, with an optional `:port`. This is the development-
 * friendly default CORS surface — a fresh `localbase dev` bound to loopback
 * serves a local frontend cross-origin without configuration, but a request
 * from any other site is denied. `::1` is intentionally excluded to keep the
 * default minimal and predictable.
 */
function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Decide which origin (if any) to reflect back as `Access-Control-Allow-Origin`.
 *
 * - When the operator configures an allowlist, only an exact match is echoed;
 *   any other origin returns `null` (no ACAO header → browser blocks it).
 * - With no allowlist the loopback-safe default applies.
 *
 * Returning `null` is what suppresses the header: `hono/cors` only writes
 * `Access-Control-Allow-Origin` when the origin resolver returns a truthy
 * value.
 */
function resolveCorsOrigin(
  origin: string,
  allowedOrigins: string[] | undefined
): string | null {
  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(origin) ? origin : null;
  }
  return isLoopbackOrigin(origin) ? origin : null;
}

/**
 * Build the CORS middleware from {@link SecurityConfig}. Uses `hono/cors`
 * under the hood with a computed origin resolver so disallowed origins get no
 * `Access-Control-Allow-Origin` header. Credentials are enabled only when the
 * operator explicitly sets `allowCredentials: true`.
 */
function buildCorsMiddleware(security?: SecurityConfig): MiddlewareHandler {
  const corsCfg = security?.cors;
  const allowedOrigins = corsCfg?.allowedOrigins;
  return cors({
    origin: (origin) => resolveCorsOrigin(origin, allowedOrigins),
    allowMethods:
      corsCfg?.allowedMethods ??
      ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"],
    allowHeaders: corsCfg?.allowedHeaders,
    credentials: corsCfg?.allowCredentials === true,
    maxAge: 600,
  });
}

/**
 * Build the security-headers middleware. Defaults are merged with any
 * `security.headers.extra` (extra wins on name collision). Headers are applied
 * after `next()` so they land on the real response, matching the pattern used
 * by `hono/secure-headers`.
 */
function buildSecurityHeadersMiddleware(
  security?: SecurityConfig
): MiddlewareHandler {
  const extra = security?.headers?.extra;
  const headers = extra
    ? { ...DEFAULT_SECURITY_HEADERS, ...extra }
    : { ...DEFAULT_SECURITY_HEADERS };
  const entries = Object.entries(headers);
  return async (c, next) => {
    await next();
    for (const [key, value] of entries) {
      c.res.headers.set(key, value);
    }
  };
}

/**
 * Build the request-body-size guard. Returns 413 on oversize JSON bodies.
 * Storage paths are exempt because uploads enforce their own
 * `storage.maxFileSize` (which may be many MiB); every other route — auth,
 * CRUD, admin — is bounded by the JSON limit.
 */
function buildBodyLimitMiddleware(security?: SecurityConfig): MiddlewareHandler {
  const maxSize = security?.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const limit = bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  });
  return async (c, next) => {
    if (c.req.path.startsWith("/api/storage/")) {
      return next();
    }
    return limit(c, next);
  };
}


// ─── Server factory ────────────────────────────────────────────

export interface CreateServerOptions {
  /**
   * If `auth.enabled` is true, mounts the `/api/auth/*` router. The
   * `requireAuth` middleware is also exposed via `getAuthMiddleware()`
   * on the returned app so callers can protect their own routes.
   */
  auth?: AuthConfig;
  /**
   * If `admin.enabled` is true, mounts the built-in admin UI:
   *   - `/_api/admin/*` — admin JSON API (rows CRUD, schema introspection)
   *   - `/admin/*`      — admin SPA static files (with SPA fallback)
   *
   * When `auth.enabled` is also true, every `/_api/admin/*` route is gated
   * by `requireAdmin`, which re-reads the caller's live role from `_users`
   * on each request (so demotions take effect immediately). When auth is
   * disabled, the admin API is ungated and the host is responsible for
   * binding to localhost — the CLI refuses public exposure unless the
   * user passes an explicit `--admin-unsafe-public` flag.
   */
  admin?: AdminConfig;
  /**
   * Per-table Row-Level Security policies. A table with an entry is auto-scoped
   * to the authenticated user on the public `/api/:table` routes — `select`
   * filters by the owner column, `insert` stamps it, and `update`/`delete` are
   * constrained to owned rows. Tables without an entry stay open. Requires
   * `auth.enabled`. See {@link PoliciesConfig}.
   */
  policies?: PoliciesConfig;
  /** Storage REST API options. */
  storage?: StorageRouterOptions;
  /** Live scheduler exposed through the admin jobs API when admin is enabled. */
  scheduler?: Scheduler;
  /**
   * HTTP-exposure hardening (CORS, rate limits, body size, security headers).
   * Optional; defaults are loopback-safe. See {@link SecurityConfig}.
   */
  security?: SecurityConfig;
}

export function createServer(
  db: Database,
  schema: DatabaseSchema,
  options: CreateServerOptions | AuthConfig | undefined = {}
): Hono {
  // Accept both `createServer(db, schema, { auth })` and
  // `createServer(db, schema, authConfig)` for ergonomics. Distinguish
  // the two by checking for a known auth-only field.
  const normalized: CreateServerOptions =
    options && typeof options === "object" && "enabled" in options
      ? { auth: options as AuthConfig }
      : (options as CreateServerOptions);

  // Row-Level Security requires auth: without an authenticated user there is no
  // owner to scope by. Fail loudly at startup rather than silently ignoring
  // policies (which would leave data exposed).
  if (normalized.policies && !normalized.auth?.enabled) {
    throw new Error(
      "[localbase] Row-Level Security policies require auth to be enabled. " +
        'Set auth.enabled = true in localbase.config.ts.'
    );
  }

  // Validated once at startup (throws on unknown table/column). The handlers
  // below consult this map to decide whether a request is owner-scoped.
  const policyMap = resolvePolicies(normalized.policies, schema);

  const app = new Hono();

  // ── Global security middleware (NET-P0) ──
  // Order matters: security headers and CORS run on every response; the body
  // limit guards every non-storage route. These are registered before any
  // router so they wrap all downstream handlers. Rate limiting is wired per-
  // route below (it targets only abuse-sensitive endpoints).
  app.use("*", buildSecurityHeadersMiddleware(normalized.security));
  app.use("*", buildCorsMiddleware(normalized.security));
  app.use("*", buildBodyLimitMiddleware(normalized.security));

  // One shared rate-limit instance, keyed by `routePath|ip`, so each abuse-
  // sensitive route counts independently per client IP. Built from
  // `security.rateLimits` (defaults: 60s window, 20 requests).
  const rateLimitMiddleware = rateLimit({
    windowMs: normalized.security?.rateLimits?.windowMs ?? 60_000,
    max: normalized.security?.rateLimits?.max ?? 20,
  });

  // ── Auth router (optional) ──
  // Mounted first so its specific paths (`/api/auth/signup`, etc.) take
  // precedence over the generic `/api/:table/:id` routes below. Without
  // this, `GET /api/auth/user` would be interpreted as a request for row
  // `user` of table `auth`.
  let authRouter: ReturnType<typeof createAuthRouter> | null = null;
  // `resolvedSecret` and `auth` are hoisted out so the admin block can reuse
  // them: the secret gates `/_api/admin/*` with `requireAdmin`, and `auth`
  // mounts the Auth Manager endpoints. Both are only set when auth is enabled.
  let resolvedSecret: string | undefined;
  let auth: Auth | undefined;
  if (normalized.auth?.enabled) {
    // Ensure the auth tables exist on this database. This covers the case
    // where the user passed auth to createServer but not to the Database
    // constructor (e.g. legacy third-arg form). When both are passed,
    // this is a no-op.
    db.enableAuth(normalized.auth);
    const { config, secretWasGenerated } = resolveAuthConfig(normalized.auth);
    resolvedSecret = config.jwtSecret;
    if (secretWasGenerated) {
      console.warn(
        "[localbase] auth.jwtSecret is not set. Generated a random one \u2014 " +
          "all sessions will be invalidated on the next restart. " +
          'Set auth.jwtSecret in localbase.config.ts (e.g. process.env.JWT_SECRET).'
      );
    }
    auth = new Auth(db, config);
    authRouter = createAuthRouter(auth, config.jwtSecret, {
      rateLimit: rateLimitMiddleware,
    });
    app.route("/", authRouter);
  }

  // ── Admin (optional) ──
  // Mounts both the admin JSON API and the SPA static files.
  //
  // Gating policy (Decision #6 / #10 of the admin plan):
  //   - When auth is enabled, every /_api/admin/* route is gated by
  //     requireAdmin(secret), which re-reads the live role from _users.
  //   - When auth is disabled, the admin API mounts UNGATED. Core cannot
  //     know the network binding, so it logs a warning; the CLI enforces
  //     the localhost-only policy and refuses public exposure unless the
  //     user passes an explicit `--admin-unsafe-public` flag.
  if (normalized.admin?.enabled) {
    if (!normalized.auth?.enabled) {
      console.warn(
        "[localbase] Admin UI is enabled with auth disabled. The admin " +
          "API is therefore UNGATED — anyone who can reach this port has " +
          "full admin access. Ensure the server is bound to 127.0.0.1 (the " +
          "CLI enforces this unless --admin-unsafe-public is passed)."
      );
    }
    const adminRouter = createAdminRouter(db, {
      requireAdminSecret: resolvedSecret,
      // When auth is on, mount the Auth Manager endpoints. They go through the
      // typed Auth helpers (hashing + last-admin lockout) and are gated by the
      // same requireAdmin secret above. When auth is off there are no users to
      // manage, so this stays undefined and the user endpoints aren't mounted.
      auth,
      scheduler: normalized.scheduler,
      rateLimit: rateLimitMiddleware,
    });
    app.route("/", adminRouter);
    const { servingPlaceholder } = mountAdminStatic(app, { enabled: true });
    if (servingPlaceholder) {
      console.info(
        "[localbase] Admin SPA bundle not found — serving placeholder at /admin."
      );
    }
  }

  // ── Storage router ──
  // Mounted before the generic /api/:table routes so /api/storage/* is handled
  // by typed storage endpoints rather than being treated as a table named
  // "storage".
  //
  // Security gate wiring (M3): Bearer-token checks must always use the
  // resolved auth JWT secret, while signed URLs use the dedicated
  // `storage.secret` if provided, otherwise the auth secret. When auth is
  // disabled (`resolvedSecret` undefined), writes/listing and private reads
  // fail closed; public bucket reads can still be served.
  const signedUrlSecret = normalized.storage?.secret ?? resolvedSecret;
  app.route(
    "/",
    createStorageRouter(db, {
      ...normalized.storage,
      authSecret: resolvedSecret,
      signedUrlSecret,
      rateLimit: rateLimitMiddleware,
    })
  );

  // ── Row-Level Security scope resolver ──
  // For each /api/:table request this decides whether the call is scoped to the
  // authenticated user. Tables without a policy are open (userId null, never
  // rejected). Policy'd tables require a valid token (else `reject` → the
  // handler returns 401) and scope by user id — unless adminBypass lets an
  // admin-role user through unscoped. See packages/core/src/rls.ts.
  const resolveOwnerScope = async (
    c: Context,
    tableName: string
  ): Promise<{ userId: number | null; reject: boolean }> => {
    const policy = policyMap.get(tableName);
    if (!policy) return { userId: null, reject: false };
    const user = await authenticate(c, resolvedSecret!);
    if (!user) return { userId: null, reject: true };
    if (policy.adminBypass && liveAdminRole(db, user.id)) {
      return { userId: null, reject: false };
    }
    return { userId: user.id, reject: false };
  };

  // ── GET /api/:table — list rows ──
  app.get("/api/:table", async (c) => {
    const tableName = c.req.param("table");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const scope = await resolveOwnerScope(c, tableName);
      if (scope.reject) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const url = new URL(c.req.url);
      const options = parseQueryOptions(url, tableName, schema);
      if (scope.userId !== null) {
        const policy = policyMap.get(tableName)!;
        options.filters = [
          ...(options.filters ?? []),
          ownerFilter(policy, scope.userId),
        ];
      }
      const rows = db.select(tableName, options);
      return c.json({ data: rows });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── GET /api/:table/:id — get one row ──
  app.get("/api/:table/:id", async (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    const scope = await resolveOwnerScope(c, tableName);
    if (scope.reject) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // Unscoped (no policy / admin bypass): fetch directly by id.
    if (scope.userId === null) {
      const row = db.selectById(tableName, id);
      if (!row) {
        return c.json({ error: "Row not found" }, 404);
      }
      return c.json({ data: row });
    }

    // Scoped: require both the id AND ownership. A row that exists but isn't
    // owned reads as "not found" (404, not 403) so existence isn't leaked.
    const policy = policyMap.get(tableName)!;
    const rows = db.select(tableName, {
      filters: [
        { column: "id", operator: "eq", value: id },
        ownerFilter(policy, scope.userId),
      ],
    });
    if (rows.length === 0) {
      return c.json({ error: "Row not found" }, 404);
    }
    return c.json({ data: rows[0] });
  });

  // ── POST /api/:table — insert row ──
  app.post("/api/:table", async (c) => {
    const tableName = c.req.param("table");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const scope = await resolveOwnerScope(c, tableName);
      if (scope.reject) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const body = (await c.req.json()) as Record<string, unknown>;
      // Stamp the owner BEFORE validation so a NOT NULL owner column satisfies
      // the required-column check, and so a client can never write as another
      // user (the stamp overrides any supplied value).
      if (scope.userId !== null) {
        stampOwner(policyMap.get(tableName)!, body, scope.userId);
      }
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
      const scope = await resolveOwnerScope(c, tableName);
      if (scope.reject) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const body = await c.req.json();
      const validated = validateBody(body, schema, tableName, true); // partial = true

      const filters: Filter[] = [{ column: "id", operator: "eq", value: id }];
      if (scope.userId !== null) {
        const policy = policyMap.get(tableName)!;
        // A scoped user cannot reassign ownership — drop any attempt to change
        // the owner column, then constrain the update to rows they own.
        delete validated[policy.ownerColumn];
        filters.push(ownerFilter(policy, scope.userId));
        if (Object.keys(validated).length === 0) {
          // Nothing updatable remains (e.g. only the protected owner column was
          // supplied, or an empty body). Return the current row unchanged — a
          // graceful no-op — rather than erroring. Scoped fetch keeps this from
          // leaking a row the caller doesn't own.
          const existing = db.select(tableName, { filters });
          if (existing.length === 0) {
            return c.json({ error: "Row not found" }, 404);
          }
          return c.json({ data: existing[0] });
        }
      }

      const result = db.update(tableName, validated, filters);

      if (result.length === 0) {
        return c.json({ error: "Row not found" }, 404);
      }

      return c.json({ data: result[0] });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── DELETE /api/:table/:id — delete row ──
  app.delete("/api/:table/:id", async (c) => {
    const tableName = c.req.param("table");
    const id = c.req.param("id");

    if (!(tableName in schema)) {
      return c.json({ error: `Unknown table: "${tableName}"` }, 404);
    }

    try {
      const scope = await resolveOwnerScope(c, tableName);
      if (scope.reject) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const filters: Filter[] = [{ column: "id", operator: "eq", value: id }];
      if (scope.userId !== null) {
        filters.push(ownerFilter(policyMap.get(tableName)!, scope.userId));
      }

      const count = db.delete(tableName, filters);

      if (count === 0) {
        return c.json({ error: "Row not found" }, 404);
      }

      return c.json({ data: { deleted: true } });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ── Health check ──
  app.get("/", (c) => c.json({ status: "ok", version: "0.1.0" }));

  return app;
}

// ─── Admin bypass helper ───────────────────────────────────────

// `liveAdminRole` now lives in rls.ts and is shared with the realtime
// subscription resolver, so the REST and realtime surfaces agree on what
// "is this user an admin right now?" means. See packages/core/src/rls.ts.

// ─── Error handler ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(c: any, err: unknown) {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 500);
  }

  // AdminError is the shared client-error type thrown by the query layer
  // (e.g. assertSafeColumn/assertSafeTable on a regex-failing identifier).
  // Mapping it here keeps the PUBLIC /api/* surface returning a clean 400
  // (instead of a 500 + stderr stack trace) for a declared column whose name
  // fails the identifier regex. Without this, a filter like ?a%20b=eq.x on a
  // table with a column "a b" would 500.
  if (err instanceof AdminError) {
    return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409);
  }

  // Catch SQLite constraint violations and return 409 Conflict
  if (err instanceof Error && "code" in err) {
    const sqliteErr = err as Error & { code: string };
    if (sqliteErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return c.json({ error: sqliteErr.message }, 409);
    }
    if (sqliteErr.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return c.json(
        { error: "Foreign key constraint failed — delete or update the referenced rows first." },
        409
      );
    }
    if (sqliteErr.code.startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: sqliteErr.message }, 400);
    }
  }

  console.error("Internal error:", err);
  return c.json({ error: "Internal server error" }, 500);
}
