export type ColumnType = "integer" | "text" | "real" | "blob" | "boolean";

export interface ColumnSchema {
  type: ColumnType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  nullable?: boolean;
  unique?: boolean;
  default?: string;
  references?: { table: string; column: string };
}

export interface TableSchema {
  [columnName: string]: ColumnSchema;
}

export interface DatabaseSchema {
  [tableName: string]: TableSchema;
}

/**
 * Configuration for the auth subsystem, which is enabled by default.
 *
 * Omit the whole section (or set `enabled: true`) to provision the `_users`
 * and `_sessions` system tables and expose `/api/auth/*` endpoints. Set
 * `enabled: false` to explicitly opt out.
 *
 * If `jwtSecret` is omitted, a random one is generated at startup and a
 * warning is logged. In production, always set an explicit secret — random
 * secrets are invalidated on every restart and will sign everyone out.
 */
export interface AuthConfig {
  /** Set to false to opt out. Auth defaults to enabled. */
  enabled?: boolean;
  jwtSecret?: string;
  /** JWT expiry shorthand accepted by `jose` (e.g. "1h", "15m", "7d"). Default: "1h" */
  accessTokenExpiry?: string;
  /** Refresh-token lifetime as a seconds number. Default: 30 days (2592000s). */
  refreshTokenExpiry?: number;
  /** Minimum password length enforced on signup. Default: 8. */
  minPasswordLength?: number;
}

/**
 * Row-Level Security policy for a single table.
 *
 * Declares which column holds the owning user's id (`_users.id`). When a table
 * has a policy, the public REST API (`/api/:table`) auto-scopes every request
 * to the authenticated user: `select` filters by the owner column, `insert`
 * stamps it, and `update`/`delete` are constrained to owned rows.
 *
 * By default this scopes EVERYONE — including admins — to their own rows; admins
 * oversee all data through the separate `/_api/admin/*` surface. Set
 * `adminBypass: true` to let admin-role users see every row on this table via
 * the public API as well.
 */
export interface OwnerPolicy {
  /** Column holding the owner's `_users.id`. Must exist on the table. */
  ownerColumn: string;
  /** When true, admin-role users skip owner scoping on this table. Default false. */
  adminBypass?: boolean;
}

/**
 * Per-table RLS policies, keyed by table name. Each entry opts that table into
 * owner-based row-level security on the public REST API. Requires `auth.enabled`.
 */
export interface PoliciesConfig {
  [tableName: string]: OwnerPolicy;
}

/**
 * Configuration for a storage bucket.
 *
 * Buckets can be pre-declared in `localbase.config.ts` to set their visibility
 * up-front. If a bucket is not declared, it is created automatically on the
 * first upload, and it defaults to private.
 */
export interface BucketConfig {
  /** Bucket name. Must match `[a-z0-9-]{1,63}`. */
  name: string;
  /** When true, files in this bucket can be read without authentication. */
  public?: boolean;
}

/**
 * Cross-cutting options for the storage subsystem.
 *
 * `secret` signs and verifies storage URLs; it falls back to `auth.jwtSecret`
 * when omitted (see `createServer`). `maxFileSize` caps a single upload.
 *
 * Pre-declared buckets live in the top-level `buckets` array rather than
 * here, to match the shape introduced in M1.
 */
export interface StorageConfig {
  /**
   * HMAC secret for signed storage URLs. Falls back to `auth.jwtSecret`.
   * When neither is set (and auth is disabled), storage is open — no
   * read/write gates and no signed URLs can be issued.
   */
  secret?: string;
  /** Maximum upload size in bytes. Default ~50 MiB. */
  maxFileSize?: number;
}

/**
 * Configuration for a single scheduled job.
 *
 * Jobs are declared in `localbase.config.ts` under the top-level `jobs` map;
 * the map's keys are the job names. A job is loaded once at startup: its
 * `handler` file is imported (relative to the project cwd) and invoked on
 * the cron `schedule`. Every run — scheduled or manual — is recorded in
 * the `_job_runs` system table.
 */
export interface JobConfig {
  /** Standard 5-field cron: "m h dom mon dow". e.g. "0 3 * * *" = 3 AM daily. */
  schedule: string;
  /** Path (relative to project cwd) to a handler file. Default-exports an async fn. */
  handler: string;
  /** IANA timezone, e.g. "America/New_York". Default: server local. */
  timezone?: string;
  /** Set false to register-but-pause. Default: true. */
  enabled?: boolean;
  /** Free-text note shown in `jobs list` and the dashboard. */
  description?: string;
}

/**
 * CORS policy. See {@link SecurityConfig}.
 *
 * By default (when `allowedOrigins` is unset or empty) the server reflects
 * only loopback origins — `http(s)://localhost:*` and `http(s)://127.0.0.1:*`,
 * any port — so a fresh `localbase dev` works for a local frontend without
 * opening the API up to every site the operator visits. To accept requests
 * from a deployed frontend, list its exact origin(s) here.
 *
 * Credentials (cookies / `Authorization`) are echoed only when
 * `allowCredentials` is explicitly `true`; the default is `false` so a random
 * public page cannot read authenticated responses even if its origin were to
 * be allowed.
 */
export interface CorsConfig {
  /**
   * Exact origin strings allowed cross-origin, e.g.
   * `["https://app.example.com"]`. When unset/empty the loopback-safe
   * default applies. The literal `"*"` is honored as-is, but note it is
   * incompatible with `allowCredentials` per the CORS spec.
   */
  allowedOrigins?: string[];
  /** Methods advertised on preflight. Defaults to the standard REST set. */
  allowedMethods?: string[];
  /**
   * Request headers advertised on preflight. When omitted the server
   * reflects the client's `Access-Control-Request-Headers` (dev-friendly).
   */
  allowedHeaders?: string[];
  /** When `true`, sets `Access-Control-Allow-Credentials: true`. Default `false`. */
  allowCredentials?: boolean;
}

/**
 * Per-IP rate-limit policy applied to abuse-sensitive routes (sign-up,
 * sign-in, refresh, admin-account requests, password operations, signed-URL
 * creation). A single policy is shared; each route counts independently per
 * client IP, so exhausting the budget on `/signin` does not block `/signup`.
 */
export interface RateLimitsConfig {
  /** Fixed-window length in milliseconds. Default 60000 (1 minute). */
  windowMs?: number;
  /** Max requests per window, per route, per IP. Default 20. */
  max?: number;
}

/**
 * HTTP-exposure hardening options (NET-P0).
 *
 * Every field is optional with loopback-safe defaults, so a localhost
 * `localbase dev` keeps working out of the box, while a deployment on a
 * non-loopback interface is locked down unless explicitly opened up.
 *
 * NOTE ON TLS: these controls operate at the HTTP layer and assume the
 * operator terminates TLS upstream (a reverse proxy, or an explicit TLS
 * listener). Serving access tokens or admin traffic over plain HTTP on a
 * non-loopback interface is unsafe regardless of CORS or rate-limiting —
 * configure TLS termination before exposing the server beyond localhost.
 */
export interface SecurityConfig {
  /** CORS policy. Defaults to loopback-only origins. See {@link CorsConfig}. */
  cors?: CorsConfig;
  /** Per-IP rate limits for abuse-sensitive routes. See {@link RateLimitsConfig}. */
  rateLimits?: RateLimitsConfig;
  /**
   * Maximum request body size in bytes for JSON API routes (auth, CRUD,
   * admin). Storage uploads are exempt — they enforce their own
   * `storage.maxFileSize`. Default ~1 MiB (1048576).
   */
  bodyLimitBytes?: number;
  /**
   * Optional extra security headers merged on top of the defaults
   * (`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`).
   * Entries here override a default of the same header name.
   */
  headers?: { extra?: Record<string, string> };
  /**
   * Whether to trust reverse-proxy forwarding headers (`X-Forwarded-For` for
   * rate-limit client IPs, `X-Forwarded-Host` / `X-Forwarded-Proto` for signed
   * storage URL origins). Default `false` — enable only when LocalBase sits
   * behind a trusted reverse proxy that strips/overwrites these headers.
   */
  trustProxy?: boolean;
}

export interface LocalBaseConfig {
  tables: DatabaseSchema;
  auth?: AuthConfig;
  realtime?: RealtimeConfig;
  /** Per-table RLS policies. Requires `auth.enabled`. See {@link OwnerPolicy}. */
  policies?: PoliciesConfig;
  /** Optional pre-declared storage buckets. */
  buckets?: BucketConfig[];
  /** Storage subsystem options (signed-URL secret, upload size cap). */
  storage?: StorageConfig;
  /** Cron-scheduled jobs. Keys are job names. See {@link JobConfig}. */
  jobs?: Record<string, JobConfig>;
  /**
   * HTTP-exposure hardening (CORS, rate limits, body size, security headers).
   * All optional with loopback-safe defaults. See {@link SecurityConfig}.
   */
  security?: SecurityConfig;
}

export interface RealtimeConfig {
  /** Whether realtime subscriptions are enabled. Default: true. */
  enabled?: boolean;
  /** Path for the WebSocket endpoint. Default: /realtime */
  path?: string;
  /** Number of recent events kept for reconnect replay. Default: 1000. */
  eventLogSize?: number;
  /** Whether presence messages are accepted. Default: true. */
  presence?: boolean;
  /**
   * Seconds the server waits for the initial authentication message before
   * closing the socket. Only meaningful when auth is enabled (a JWT secret is
   * supplied to the realtime server). Default: 10.
   */
  authTimeoutMs?: number;
  /**
   * Milliseconds between server-initiated pings used for liveness and idle
   * cleanup. A socket that neither pongs nor sends application traffic within
   * roughly 2x this interval is terminated. Default: 30000 (30s). Set to 0 to
   * disable.
   */
  pingIntervalMs?: number;
  /** Abuse/DoS bounds for realtime sockets. See {@link RealtimeLimits}. */
  limits?: RealtimeLimits;
}

/**
 * Tunable bounds that keep a single realtime socket from exhausting server
 * memory or CPU. All default to conservative values suitable for a
 * single-process preview; override per-deployment in `localbase.config.ts`.
 */
export interface RealtimeLimits {
  /** Max simultaneous subscriptions per socket. Default: 100. */
  maxSubscriptionsPerSocket?: number;
  /** Max filters in a single subscription. Default: 16. */
  maxFiltersPerSubscription?: number;
  /** Max presence channels joined per socket. Default: 32. */
  maxPresenceChannelsPerSocket?: number;
  /** Max byte length of a presence channel or key string. Default: 128. */
  maxPresenceKeyLength?: number;
  /** Max serialized size (bytes) of presence metadata. Default: 4096. */
  maxPresenceMetadataBytes?: number;
  /**
   * Max inbound application messages per second per socket before the socket is
   * closed as abusive. Default: 50.
   */
  maxMessagesPerSecond?: number;
  /**
   * Max outbound bytes buffered on a slow consumer's socket before the
   * connection is terminated (backpressure protection). Default: 1 MiB.
   */
  maxBufferedBytes?: number;
  /** Max inbound frame size in bytes (WS payload). Default: 1 MiB. */
  maxPayloadBytes?: number;
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

// ─── Realtime types ────────────────────────────────────────────

export type ChangeEventType = "insert" | "update" | "delete";

export interface RealtimeFilter {
  column: string;
  operator: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "like" | "in";
  value: unknown;
}

export interface RealtimeEvent<T = unknown> {
  type: ChangeEventType;
  table: string;
  row: T;
  /** Monotonic server-assigned sequence number within the current epoch. */
  id?: number;
  /** ISO timestamp assigned by the realtime server. */
  timestamp?: string;
  /**
   * Opaque, epoch-aware cursor clients echo back to request replay. Unlike a
   * bare sequence id, it encodes the server epoch so a reconnect after a
   * server restart — or after events have fallen out of the bounded replay
   * buffer — produces an explicit `resync-required` instead of a silently
   * incomplete history.
   */
  cursor?: string;
}

export interface PresenceState<T = unknown> {
  channel: string;
  key: string;
  metadata?: T;
  joinedAt: string;
  updatedAt: string;
}

export interface PresenceEvent<T = unknown> {
  type: "sync" | "join" | "update" | "leave";
  channel: string;
  key?: string;
  state?: PresenceState<T>;
  states?: PresenceState<T>[];
}

export const VERSION = "0.1.0-beta.2";

// ─── Admin UI types ───────────────────────────────────────────

/**
 * Configuration for the optional built-in Admin UI.
 *
 * When `enabled: true`, `createServer` mounts:
 *   - `/_api/admin/*` — admin JSON API (rows CRUD, schema introspection)
 *   - `/admin/*`      — admin SPA static files (with SPA fallback to index.html)
 *
 * When auth is enabled, the admin API is gated by `requireAdmin`, which
 * re-reads the caller's live role from `_users` on every request. When auth
 * is disabled, the API is ungated and must only be exposed on localhost
 * unless the host explicitly opts into unsafe public serving.
 */
export interface AdminConfig {
  enabled: boolean;
}

/**
 * A column as it actually exists in SQLite, surfaced by `Database.introspect()`.
 * Distinct from `ColumnSchema` (which is the user's *declared* shape) — this
 * is the truth the DBMS reports.
 */
export interface IntrospectedColumn {
  name: string;
  /** SQLite type affinity: INTEGER | TEXT | REAL | BLOB. */
  type: string;
  notNull: boolean;
  /** True when this column is the table's primary key. */
  primaryKey: boolean;
  /** True when INTEGER PRIMARY KEY (rowid alias) — auto-incrementing. */
  autoIncrement: boolean;
  defaultValue: string | null;
}

/**
 * A foreign key relationship on a table.
 */
export interface IntrospectedForeignKey {
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

/**
 * An index on a table (excluding auto-created internal indexes).
 */
export interface IntrospectedIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

/**
 * A table as it actually exists in SQLite.
 *
 * `system` is true for tables that LocalBase owns internally (prefixed with
 * `_`, e.g. `_users`, `_sessions`). The admin API uses this to gate writes
 * — modifying a system table must go through the typed Auth/Storage
 * helpers so invariants (password hashing, claim refresh) are preserved.
 */
export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  primaryKey: string[];
  foreignKeys: IntrospectedForeignKey[];
  indexes: IntrospectedIndex[];
  rowCount: number;
  system: boolean;
  /**
   * True for virtual tables (`CREATE VIRTUAL TABLE`, e.g. fts5) and the
   * "shadow" tables a virtual module creates to back itself
   * (e.g. `ft_content`, `ft_data`). The admin row API treats virtual tables
   * as read-only — direct INSERT/UPDATE/DELETE would corrupt the index or
   * bypass the module's invariants — so it blocks writes to them. Reads
   * remain allowed so the schema viewer can surface them.
   */
  virtual: boolean;
}

/**
 * Full introspection result for a database, keyed by table name.
 */
export interface IntrospectedSchema {
  tables: IntrospectedTable[];
}
