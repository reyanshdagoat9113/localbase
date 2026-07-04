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
 * Configuration for the optional auth subsystem.
 *
 * When `enabled: true`, LocalBase provisions the `_users` and `_sessions`
 * system tables and exposes `/api/auth/*` endpoints.
 *
 * If `jwtSecret` is omitted, a random one is generated at startup and a
 * warning is logged. In production, always set an explicit secret — random
 * secrets are invalidated on every restart and will sign everyone out.
 */
export interface AuthConfig {
  enabled: boolean;
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
  /** Monotonic server-assigned id used to replay missed events. */
  id?: number;
  /** ISO timestamp assigned by the realtime server. */
  timestamp?: string;
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

export const VERSION = "0.1.0";

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
