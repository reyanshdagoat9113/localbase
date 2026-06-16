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
