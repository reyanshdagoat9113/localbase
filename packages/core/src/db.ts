import BetterSqlite3 from "better-sqlite3";
import { EventEmitter } from "node:events";
import nodePath from "node:path";
import type {
  AuthConfig,
  BucketConfig,
  DatabaseSchema,
  IntrospectedSchema,
  RealtimeEvent,
} from "@localbase/shared";
import { schemaToDDL } from "./ddl.js";
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
import { introspect as runIntrospect } from "./admin/introspect.js";
import { AUTH_SCHEMA } from "./auth/index.js";
import { STORAGE_SCHEMA } from "./storage/schema.js";
import { StorageEngine } from "./storage/engine.js";

export interface DatabaseOptions {
  /** Path to the SQLite file. Use ":memory:" for in-memory databases. */
  path?: string;
  /** The schema definition. */
  schema: DatabaseSchema;
  /**
   * If provided with `enabled: true`, LocalBase will provision the `_users`
   * and `_sessions` system tables and prepare for the auth router to mount.
   * The user never has to declare these tables in their `schema` — they're
   * added here automatically.
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
  /** If true, automatically run migrations on open. Default: true. */
  autoMigrate?: boolean;
}

export interface DatabaseEvents {
  change: [RealtimeEvent];
}

export class Database extends EventEmitter<DatabaseEvents> {
  private db: BetterSqlite3.Database;
  private schema: DatabaseSchema;
  /** Effective schema including system tables, used for migrations. */
  private effectiveSchema: DatabaseSchema;
  private authConfig?: AuthConfig;
  /** Storage engine for file uploads/downloads. */
  storage: StorageEngine;

  constructor(options: DatabaseOptions) {
    super();
    const {
      path = ":memory:",
      schema,
      auth,
      dataDir,
      buckets,
      autoMigrate = true,
    } = options;

    this.db = new BetterSqlite3(path);
    this.schema = schema;
    this.authConfig = auth;

    // System tables get the `_` prefix, which `resetDatabase` filters out, so
    // user resets never wipe auth or storage metadata.
    this.effectiveSchema = { ...schema, ...STORAGE_SCHEMA };
    if (auth?.enabled) {
      this.effectiveSchema = { ...this.effectiveSchema, ...AUTH_SCHEMA };
    }

    const resolvedDataDir =
      dataDir ?? (path === ":memory:" ? process.cwd() : nodePath.dirname(path));

    // Enable foreign keys
    this.db.pragma("foreign_keys = ON");

    // Auto-migrate on open
    if (autoMigrate) {
      this.migrate();
    }

    // Storage engine is created after migrations so the `_files` table exists.
    this.storage = new StorageEngine({
      db: this,
      root: resolvedDataDir,
      buckets,
    });
  }

  /** Returns the effective auth config, or undefined if auth is not enabled. */
  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  /**
   * Enable auth on an already-constructed Database. Provisions the
   * `_users` and `_sessions` system tables if they don't exist. Idempotent
   * — calling it twice is a no-op.
   *
   * This is a convenience for code that constructs the database first and
   * only later learns auth is needed. The more common pattern is to pass
   * `auth` to the `Database` constructor.
   */
  enableAuth(config: AuthConfig): void {
    if (this.authConfig?.enabled) return;
    this.authConfig = config;
    if (config.enabled) {
      this.effectiveSchema = {
        ...this.schema,
        ...STORAGE_SCHEMA,
        ...AUTH_SCHEMA,
      };
      this.migrate();
    }
  }

  /**
   * Run pending migrations against the effective schema (user tables + auth
   * tables when enabled). Returns the names of newly applied migrations.
   */
  migrate(): string[] {
    const applied = runMigrations(this.db, this.effectiveSchema);
    this.storage?.ensureIndexes();
    return applied;
  }

  /**
   * Returns the set of migration names that have been applied.
   */
  getAppliedMigrations(): Set<string> {
    return getAppliedMigrations(this.db);
  }

  /**
   * Drop all user tables and re-run migrations.
   */
  reset(): string[] {
    const applied = resetDatabase(this.db, this.effectiveSchema);
    this.storage.ensureIndexes();
    return applied;
  }

  /**
   * SELECT rows from a table.
   */
  select(table: string, options?: QueryOptions): unknown[] {
    return select(this.db, table, options);
  }

  /**
   * COUNT rows in a table, optionally filtered. Uses the same safe WHERE
   * builder as {@link select} so identifiers are validated and values are
   * bound. Used by the admin rows endpoint to report the filtered total.
   */
  count(table: string, filters?: Filter[]): number {
    return count(this.db, table, filters);
  }

  /**
   * SELECT a single row by id.
   */
  selectById(table: string, id: number | string): unknown | undefined {
    return selectById(this.db, table, id);
  }

  /**
   * INSERT one or more rows into a table.
   * Returns the inserted row(s).
   */
  insert(
    table: string,
    data: Record<string, unknown> | Record<string, unknown>[]
  ): unknown[] {
    const result = insert(this.db, table, data);
    for (const row of result) {
      this.emit("change", { type: "insert", table, row });
    }
    return result;
  }

  /**
   * UPDATE rows matching the given filters.
   * Returns the updated row(s).
   */
  update(
    table: string,
    data: Record<string, unknown>,
    filters?: Filter[]
  ): unknown[] {
    const result = update(this.db, table, data, filters);
    for (const row of result) {
      this.emit("change", { type: "update", table, row });
    }
    return result;
  }

  /**
   * DELETE rows matching the given filters.
   * Returns the count of deleted rows.
   */
  delete(table: string, filters?: Filter[]): number {
    const rows = remove(this.db, table, filters);
    for (const row of rows) {
      this.emit("change", { type: "delete", table, row });
    }
    return rows.length;
  }

  /**
   * Get the underlying better-sqlite3 instance for advanced usage.
   */
  raw(): BetterSqlite3.Database {
    return this.db;
  }

  /**
   * Introspect the actual schema of the database.
   *
   * This is the truth — what SQLite itself reports — not a reflection of
   * the `DatabaseSchema` passed to the constructor. The admin UI uses
   * this to surface schema drift, the column viewer, and to drive
   * server-side validation of admin row writes.
   */
  introspect(): IntrospectedSchema {
    return runIntrospect(this.db);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
