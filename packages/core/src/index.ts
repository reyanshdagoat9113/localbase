// Database class
export { Database } from "./db.js";
export type { DatabaseOptions } from "./db.js";

// API server
export { createServer } from "./api.js";
export type { CreateServerOptions } from "./api.js";

// DDL compiler
export { schemaToDDL, tableToDDL, columnToDDL } from "./ddl.js";

// Migrations
export { runMigrations, resetDatabase, getAppliedMigrations } from "./migrate.js";

// Query executor
export { select, selectById, insert, update, remove } from "./query.js";
export type { Filter, FilterOperator, OrderBy, QueryOptions } from "./query.js";

// Auth subsystem
export {
  AUTH_SCHEMA,
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  requireAuth,
  resolveAuthConfig,
  generateJwtSecret,
  parseExpiryToSeconds,
  DEFAULT_ACCESS_TOKEN_EXPIRY,
  DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS,
  DEFAULT_MIN_PASSWORD_LENGTH,
  Auth,
  AuthError,
  createAuthRouter,
} from "./auth/index.js";
export type {
  AuthUser,
  AuthSession,
  AuthVariables,
  AuthenticatedUser,
  AccessTokenClaims,
  RefreshTokenClaims,
  ResolvedAuthConfig,
  ResolvedAuthConfigResult,
} from "./auth/index.js";

// Re-export shared types
export type {
  ColumnType,
  ColumnSchema,
  TableSchema,
  DatabaseSchema,
  LocalBaseConfig,
  AuthConfig,
  ApiResponse,
} from "@localbase/shared";
