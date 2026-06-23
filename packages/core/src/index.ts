// Database class
export { Database } from "./db.js";
export type { DatabaseOptions } from "./db.js";

// API server
export { createServer } from "./api.js";
export type { CreateServerOptions } from "./api.js";

// DDL compiler
export {
  schemaToDDL,
  tableToDDL,
  columnToDDL,
  columnToAddDDL,
  topologicalSort,
  AdditiveMigrationError,
} from "./ddl.js";

// Migrations
export { runMigrations, resetDatabase, getAppliedMigrations } from "./migrate.js";

// Query executor
export { select, selectById, insert, update, remove } from "./query.js";
export type { Filter, FilterOperator, OrderBy, QueryOptions } from "./query.js";

// Row-Level Security
export { resolvePolicies, ownerFilter, stampOwner } from "./rls.js";
export type { ResolvedPolicy } from "./rls.js";

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

// Realtime subsystem
export {
  createRealtimeServer,
  SubscriptionManager,
  rowMatchesFilters,
} from "./realtime/index.js";
export type {
  RealtimeServer,
  RealtimeServerOptions,
  ClientSubscription,
} from "./realtime/index.js";

// Admin subsystem
export { createAdminRouter } from "./admin/router.js";
export { mountAdminStatic, findAdminDistPath } from "./admin/static.js";
export { introspect } from "./admin/introspect.js";
export { SYSTEM_TABLES, isSystemTable, assertNotSystemTable } from "./admin/system-tables.js";

// Storage subsystem
export { StorageEngine, StorageError } from "./storage/engine.js";
export { STORAGE_SCHEMA } from "./storage/schema.js";
export { createStorageRouter, DEFAULT_MAX_FILE_SIZE } from "./storage/router.js";
export type {
  StoredFile,
  SaveResult,
  UploadPayload,
} from "./storage/engine.js";
export type { StorageRouterOptions } from "./storage/router.js";

// Re-export shared types
export type {
  ColumnType,
  ColumnSchema,
  TableSchema,
  DatabaseSchema,
  LocalBaseConfig,
  AuthConfig,
  AdminConfig,
  PoliciesConfig,
  OwnerPolicy,
  BucketConfig,
  IntrospectedColumn,
  IntrospectedTable,
  IntrospectedSchema,
  IntrospectedIndex,
  IntrospectedForeignKey,
  ApiResponse,
  RealtimeConfig,
  RealtimeEvent,
  RealtimeFilter,
  PresenceEvent,
  PresenceState,
  ChangeEventType,
} from "@localbase/shared";
