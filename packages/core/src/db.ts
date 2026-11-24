import type BetterSqlite3 from "better-sqlite3";
import { EventEmitter } from "node:events";
import nodePath from "node:path";
import type {
  AuthConfig,
  BucketConfig,
  DatabaseSchema,
  IntrospectedSchema,
  IntrospectedTable,
  JobConfig,
  RealtimeEvent,
} from "@localbase/shared";
import {
  SqliteDriver,
  type DbDriver,
  type QueryExecutor,
  type SqlDialect,
} from "./db/index.js";
import { runMigrations, resetDatabase, getAppliedMigrations } from "./migrate.js";
import {
  select,
  selectById,
  insert,
  update,
  remove,
  count,
  type Filter,
  type QueryOptions,
} from "./query.js";
import { AUTH_SCHEMA } from "./auth/index.js";
import { STORAGE_SCHEMA } from "./storage/schema.js";
import { JOBS_SCHEMA } from "./jobs/schema.js";
import { StorageEngine } from "./storage/engine.js";

export interface DatabaseOptions {
  /** Path to the SQLite file. Use ":memory:" for in-memory databases. */
  path?: string;
  /**
   * Optional pre-built {@link DbDriver} (used by PostgresDriver in M2 and
   * custom test harnesses). When omitted, opens a {@link SqliteDriver} at `path`.
   */
  driver?: DbDriver;
  /** The schema definition. */
  schema: DatabaseSchema;
  /**
   * If provided without `enabled: false`, LocalBase will provision the
   * `_users`, `_sessions`, and `_admin_requests` system tables and prepare for
   * the auth router to mount.
   */
  auth?: AuthConfig;
  /**
   * Root directory for local file storage. Files are written under
   * `<dataDir>/storage/<bucket>/<stored_name>`. Defaults to the directory
   * containing the SQLite file, or `process.cwd()` for `:memory:` databases.
   */
  dataDir?: string;
  /** Optional pre-declared storage buckets. */
  buckets?: BucketConfig[];
  /**
   * Scheduled jobs declared in `localbase.config.ts`. When provided,
   * LocalBase provisions the `_job_runs` system table.
   */
  jobs?: Record<string, JobConfig>;
  /** If true, automatically run migrations on open. Default: true. */
  autoMigrate?: boolean;
}

export interface DatabaseEvents {
  change: [RealtimeEvent];
}

export class Database extends EventEmitter<DatabaseEvents> {
  private readonly driver: DbDriver;
  private schema: DatabaseSchema;
  /** Effective schema including system tables, used for migrations. */
  private effectiveSchema: DatabaseSchema;
  /** Map of table name -> set of declared boolean column names for read normalization. */
  private booleanColumns: Map<string, Set<string>>;
  private authConfig?: AuthConfig;
  /** Whether the jobs subsystem (_job_runs table) has been provisioned. */
  private jobsEnabled: boolean;
  private dataDir: string;
  /** Storage engine for file uploads/downloads. */
  storage: StorageEngine;

  private constructor(options: DatabaseOptions, driver: DbDriver) {
    super();
    const {
      path = ":memory:",
      schema,
      auth,
      dataDir,
      buckets,
      jobs,
    } = options;

    this.driver = driver;
    this.schema = schema;
    this.authConfig =
      auth && auth.enabled !== false ? { ...auth, enabled: true } : undefined;

    this.effectiveSchema = { ...schema, ...STORAGE_SCHEMA };
    if (this.authConfig) {
      this.effectiveSchema = { ...this.effectiveSchema, ...AUTH_SCHEMA };
    }
    this.jobsEnabled = jobs !== undefined;
    if (this.jobsEnabled) {
      this.effectiveSchema = { ...this.effectiveSchema, ...JOBS_SCHEMA };
    }

    this.booleanColumns = buildBooleanColumnMap(this.effectiveSchema);
    this.dataDir =
      dataDir ?? (path === ":memory:" ? process.cwd() : nodePath.dirname(path));

    this.storage = new StorageEngine({
      db: this,
      root: this.dataDir,
      buckets,
    });
  }

  /**
   * Open a LocalBase database and optionally run pending migrations.
   */
  static async open(options: DatabaseOptions): Promise<Database> {
    const driver = options.driver ?? new SqliteDriver(options.path ?? ":memory:");
    const instance = new Database(options, driver);
    try {
      if (options.autoMigrate !== false) {
        await instance.migrate();
      }
    } catch (err) {
      await driver.close().catch(() => {});
      throw err;
    }
    return instance;
  }

  /** Active SQL dialect (`sqlite` or `postgres`). */
  get dialect(): SqlDialect {
    return this.driver.dialect;
  }

  /** Active database driver (internal/advanced usage). */
  getDriver(): DbDriver {
    return this.driver;
  }

  /**
   * Direct `better-sqlite3` handle for SQLite-only operations (such as the
   * online backup API in `backup.ts`). Throws on non-SQLite drivers.
   */
  sqliteRaw(): BetterSqlite3.Database {
    if (this.driver instanceof SqliteDriver) {
      return this.driver.sqliteRaw();
    }
    throw new Error(
      `sqliteRaw() is only available on SQLite databases (current engine: ${this.driver.dialect.engine}).`
    );
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  getJobsEnabled(): boolean {
    return this.jobsEnabled;
  }

  async enableAuth(config: AuthConfig): Promise<void> {
    if (this.authConfig || config.enabled === false) return;
    this.authConfig = { ...config, enabled: true };
    this.effectiveSchema = {
      ...this.schema,
      ...STORAGE_SCHEMA,
      ...(this.jobsEnabled ? JOBS_SCHEMA : {}),
      ...AUTH_SCHEMA,
    };
    this.booleanColumns = buildBooleanColumnMap(this.effectiveSchema);
    await this.migrate();
  }

  async migrate(): Promise<string[]> {
    const applied = await runMigrations(this.driver, this.effectiveSchema);
    await this.storage.ensureIndexes();
    return applied;
  }

  async getAppliedMigrations(): Promise<Set<string>> {
    return getAppliedMigrations(this.driver);
  }

  async reset(): Promise<string[]> {
    const applied = await resetDatabase(this.driver, this.effectiveSchema);
    await this.storage.ensureIndexes();
    return applied;
  }

  async select(table: string, options?: QueryOptions): Promise<unknown[]> {
    const rows = await select(this.driver, table, options);
    return this.normalizeRows(table, rows);
  }

  async count(table: string, filters?: Filter[]): Promise<number> {
    return count(this.driver, table, filters);
  }

  async selectById(
    table: string,
    id: number | string
  ): Promise<unknown | undefined> {
    const row = await selectById(this.driver, table, id);
    return row === undefined ? undefined : this.normalizeRow(table, row);
  }

  async insert(
    table: string,
    data: Record<string, unknown> | Record<string, unknown>[]
  ): Promise<unknown[]> {
    const result = this.normalizeRows(
      table,
      await insert(this.driver, table, data)
    );
    for (const row of result) {
      this.emit("change", { type: "insert", table, row });
    }
    return result;
  }

  async update(
    table: string,
    data: Record<string, unknown>,
    filters?: Filter[]
  ): Promise<unknown[]> {
    const result = this.normalizeRows(
      table,
      await update(this.driver, table, data, filters)
    );
    for (const row of result) {
      this.emit("change", { type: "update", table, row });
    }
    return result;
  }

  async delete(table: string, filters?: Filter[]): Promise<number> {
    const rows = await this.deleteReturning(table, filters);
    return rows.length;
  }

  /**
   * DELETE rows matching the given filters and return the deleted rows.
   * Emits `change` events just like {@link delete}.
   */
  async deleteReturning(table: string, filters?: Filter[]): Promise<unknown[]> {
    const rows = this.normalizeRows(
      table,
      await remove(this.driver, table, filters)
    );
    for (const row of rows) {
      this.emit("change", { type: "delete", table, row });
    }
    return rows;
  }

  /**
   * Run an atomic transaction against the underlying driver.
   */
  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return this.driver.transaction(fn);
  }

  /** Check whether a table exists in the database. */
  async tableExists(name: string): Promise<boolean> {
    return this.driver.tableExists(name);
  }

  /** Execute one or more DDL/SQL statements without parameters (e.g. indexes). */
  async execBatch(sql: string): Promise<void> {
    return this.driver.execBatch(sql);
  }

  async introspect(): Promise<IntrospectedSchema> {
    return this.driver.introspect();
  }

  async introspectTable(name: string): Promise<IntrospectedTable | null> {
    return this.driver.introspectTable(name);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private normalizeRows(table: string, rows: unknown[]): unknown[] {
    const boolCols = this.booleanColumns.get(table);
    if (!boolCols || boolCols.size === 0) return rows;
    return rows.map((row) => this.normalizeRow(table, row));
  }

  private normalizeRow(table: string, row: unknown): unknown {
    const boolCols = this.booleanColumns.get(table);
    if (!boolCols || boolCols.size === 0 || !row || typeof row !== "object") {
      return row;
    }
    const record = row as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const col of boolCols) {
      if (!(col in record)) continue;
      const val = record[col];
      if (val === null || val === undefined || typeof val === "boolean") continue;
      if (val === 0 || val === 1) {
        if (!copy) copy = { ...record };
        copy[col] = val === 1;
      }
    }
    return copy ?? row;
  }
}

function buildBooleanColumnMap(schema: DatabaseSchema): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [tableName, tableSchema] of Object.entries(schema)) {
    const cols = new Set<string>();
    for (const [colName, colDef] of Object.entries(tableSchema)) {
      if (colDef.type === "boolean") {
        cols.add(colName);
      }
    }
    if (cols.size > 0) {
      map.set(tableName, cols);
    }
  }
  return map;
}
