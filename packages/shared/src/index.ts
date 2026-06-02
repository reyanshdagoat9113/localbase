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

export interface LocalBaseConfig {
  tables: DatabaseSchema;
}

export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

export const VERSION = "0.1.0";
