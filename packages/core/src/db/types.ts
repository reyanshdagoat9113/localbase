import type {
  ColumnSchema,
  IntrospectedSchema,
  IntrospectedTable,
} from "@localbase/shared";

export type DatabaseEngine = "sqlite" | "postgres";

export type DatabaseErrorCode =
  | "unique"
  | "foreign_key"
  | "not_null"
  | "invalid_input"
  | "constraint"
  | "connection"
  | "unknown";

/**
 * Engine-agnostic database error surfaced by drivers and query helpers so HTTP
 * routers (REST, Auth, Admin) map constraint/input failures to consistent
 * status codes across SQLite and PostgreSQL.
 */
export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly engine: DatabaseEngine;
  readonly cause?: unknown;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    engine: DatabaseEngine,
    cause?: unknown
  ) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.engine = engine;
    this.cause = cause;
  }
}

/**
 * Map a raw driver error (SQLite `SQLITE_CONSTRAINT_*` or Postgres SQLSTATE)
 * into a {@link DatabaseError}. Returns `err` unchanged if it is already a
 * `DatabaseError`, or `null` if the error is not a recognized DB error.
 */
export function normalizeDatabaseError(
  err: unknown,
  engine: DatabaseEngine
): DatabaseError | null {
  if (err instanceof DatabaseError) return err;
  if (!(err instanceof Error)) return null;

  const rawCode = (err as Error & { code?: unknown }).code;
  if (typeof rawCode !== "string") return null;

  if (engine === "sqlite") {
    if (rawCode === "SQLITE_CONSTRAINT_UNIQUE" || rawCode === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return new DatabaseError("unique", err.message, "sqlite", err);
    }
    if (rawCode === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return new DatabaseError("foreign_key", err.message, "sqlite", err);
    }
    if (rawCode === "SQLITE_CONSTRAINT_NOTNULL") {
      return new DatabaseError("not_null", err.message, "sqlite", err);
    }
    if (rawCode.startsWith("SQLITE_CONSTRAINT")) {
      return new DatabaseError("constraint", err.message, "sqlite", err);
    }
    return null;
  }

  // PostgreSQL SQLSTATE codes (used by PostgresDriver in M2+).
  if (rawCode === "23505") {
    return new DatabaseError("unique", err.message, "postgres", err);
  }
  if (rawCode === "23503") {
    return new DatabaseError("foreign_key", err.message, "postgres", err);
  }
  if (rawCode === "23502") {
    return new DatabaseError("not_null", err.message, "postgres", err);
  }
  if (rawCode === "22P02" || rawCode === "22003") {
    return new DatabaseError("invalid_input", err.message, "postgres", err);
  }
  if (rawCode.startsWith("23")) {
    return new DatabaseError("constraint", err.message, "postgres", err);
  }
  if (rawCode.startsWith("08") || rawCode === "ECONNREFUSED" || rawCode === "ENOTFOUND") {
    return new DatabaseError("connection", err.message, "postgres", err);
  }
  return null;
}

/**
 * Dialect abstraction encapsulating SQL syntax differences between SQLite and
 * PostgreSQL (placeholders, DDL types, defaults, and boolean encoding).
 */
export interface SqlDialect {
  readonly engine: DatabaseEngine;
  /** 1-based parameter placeholder: `?` on SQLite, `$1` on Postgres. */
  placeholder(index: number): string;
  /** Map a LocalBase ColumnSchema to its SQL column type (e.g. INTEGER, BOOLEAN). */
  columnType(col: ColumnSchema): string;
  /** DDL fragment for an auto-incrementing primary key column (after the column name). */
  autoIncrementPrimaryKey(col: ColumnSchema): string;
  /** Normalize a declared `default` expression for this dialect. */
  normalizeDefault(col: ColumnSchema): string | undefined;
  /** Encode a JS boolean for writes (`1`/`0` on SQLite, `true`/`false` on Postgres). */
  encodeBoolean(value: boolean): number | boolean;
  /** SQL `CREATE TABLE IF NOT EXISTS` for `_migrations`. */
  migrationsTableDDL(tableName: string): string;
}

/**
 * Shared query execution surface implemented by both a root {@link DbDriver}
 * and a transaction handle passed to `driver.transaction(async (tx) => ...)`.
 */
export interface QueryExecutor {
  readonly dialect: SqlDialect;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  execBatch(sql: string): Promise<void>;
}

/**
 * Engine-agnostic database driver implemented by `SqliteDriver` (M1) and
 * `PostgresDriver` (M2).
 */
export interface DbDriver extends QueryExecutor {
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  introspect(): Promise<IntrospectedSchema>;
  introspectTable(name: string): Promise<IntrospectedTable | null>;
  tableExists(name: string): Promise<boolean>;
  existingColumns(table: string): Promise<Set<string>>;
  listUserTables(): Promise<string[]>;
  dropTablesForReset(tableNames: string[]): Promise<void>;
  close(): Promise<void>;
}
