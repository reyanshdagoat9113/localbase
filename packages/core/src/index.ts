// Database class
export { Database } from "./db.js";
export type { DatabaseOptions } from "./db.js";

// API server
export { createServer } from "./api.js";

// DDL compiler
export { schemaToDDL, tableToDDL, columnToDDL } from "./ddl.js";

// Migrations
export { runMigrations, resetDatabase, getAppliedMigrations } from "./migrate.js";

// Query executor
export { select, selectById, insert, update, remove } from "./query.js";
export type { Filter, FilterOperator, OrderBy, QueryOptions } from "./query.js";

// Re-export shared types
export type {
  ColumnType,
  ColumnSchema,
  TableSchema,
  DatabaseSchema,
  LocalBaseConfig,
  ApiResponse,
} from "@localbase/shared";
