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

export interface LocalBaseConfig {
  tables: DatabaseSchema;
  auth?: AuthConfig;
  realtime?: RealtimeConfig;
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
