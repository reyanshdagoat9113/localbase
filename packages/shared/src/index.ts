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
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

export const VERSION = "0.1.0";
