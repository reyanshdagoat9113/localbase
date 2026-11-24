import type { ColumnSchema } from "@localbase/shared";
import type { SqlDialect } from "./types.js";

/**
 * SQLite expression that produces an ISO-8601 UTC timestamp string
 * (`YYYY-MM-DDTHH:MM:SSZ`), matching the format Postgres produces via
 * `to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.
 */
const SQLITE_ISO_UTC_NOW = "(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))";

export const sqliteDialect: SqlDialect = {
  engine: "sqlite",

  placeholder(_index: number): string {
    return "?";
  },

  columnType(col: ColumnSchema): string {
    switch (col.type) {
      case "boolean":
        return "INTEGER";
      default:
        return col.type.toUpperCase();
    }
  },

  autoIncrementPrimaryKey(col: ColumnSchema): string {
    return `${this.columnType(col)} PRIMARY KEY AUTOINCREMENT`;
  },

  normalizeDefault(col: ColumnSchema): string | undefined {
    if (col.default === undefined) return undefined;
    const trimmed = col.default.trim();
    if (col.type === "boolean") {
      const lower = trimmed.toLowerCase();
      if (lower === "true") return "1";
      if (lower === "false") return "0";
    }
    if (col.type === "text" && trimmed.toUpperCase() === "CURRENT_TIMESTAMP") {
      return SQLITE_ISO_UTC_NOW;
    }
    return col.default;
  },

  encodeBoolean(value: boolean): number {
    return value ? 1 : 0;
  },

  migrationsTableDDL(tableName: string): string {
    return `
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL UNIQUE,
        "applied_at" TEXT NOT NULL DEFAULT ${SQLITE_ISO_UTC_NOW}
      );
    `;
  },
};
