import BetterSqlite3 from "better-sqlite3";
import { EventEmitter } from "node:events";
import nodePath from "node:path";
import type {
  AuthConfig,
  BucketConfig,
  DatabaseSchema,
  IntrospectedSchema,
  JobConfig,
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
import { JOBS_SCHEMA } from "./jobs/schema.js";
import { StorageEngine } from "./storage/engine.js";

export interface DatabaseOptions {
  /** Path to the SQLite file. Use ":memory:" for in-memory databases. */
  path?: string;
  /** The schema definition. */
  schema: DatabaseSchema;
  /**
   * If provided without `enabled: false`, LocalBase will provision the
   * `_users`, `_sessions`, and `_admin_requests` system tables and prepare for
   * the auth router to mount.
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
  /**
   * Scheduled jobs declared in `localbase.config.ts`. When provided,
   * LocalBase provisions the `_job_runs` system table. The runner/scheduler
   * (later milestones) is the sole writer; this option only opts the table
   * in so migrations create it.
   */
  jobs?: Record<string, JobConfig>;
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
  /** Whether the jobs subsystem (_job_runs table) has been provisioned. */
  private jobsEnabled: boolean;
  /**
   * Resolved root directory for local file storage. The storage tree lives
   * at `<dataDir>/storage/<bucket>/<file>`. Exposed via {@link getDataDir}
   * so the backup module can locate the on-disk storage tree without the
   * storage engine having to publish its internal root.
   */
  private dataDir: string;
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
      jobs,
      autoMigrate = true,
    } = options;

    this.db = new BetterSqlite3(path);
    this.schema = schema;
    this.authConfig =
      auth && auth.enabled !== false ? { ...auth, enabled: true } : undefined;

    // System tables get the `_` prefix, which `resetDatabase` filters out, so
    // user resets never wipe auth, storage, or job-run metadata.
    this.effectiveSchema = { ...schema, ...STORAGE_SCHEMA };
    if (this.authConfig) {
      this.effectiveSchema = { ...this.effectiveSchema, ...AUTH_SCHEMA };
    }
    // The jobs table is only provisioned when a `jobs` map is configured —
    // a project with no scheduled jobs never creates `_job_runs`.
    this.jobsEnabled = jobs !== undefined;
    if (this.jobsEnabled) {
      this.effectiveSchema = { ...this.effectiveSchema, ...JOBS_SCHEMA };
    }

    this.dataDir =
      dataDir ?? (path === ":memory:" ? process.cwd() : nodePath.dirname(path));

    // Enable foreign keys — cascades and RESTRICT still apply under WAL, and
    // keeping this on before any DDL means migrations are checked against the
    // declared references.
    this.db.pragma("foreign_keys = ON");

    // Write-Ahead Logging: writers don't block readers, and committed
    // transactions survive an ordinary process crash because the -wal is
    // replayed on the next open. Chosen over the default rollback journal
    // because LocalBase is a long-running single-process server where
    // concurrent reads during writes (admin, realtime, jobs) are the common
    // case. `pragma("journal_mode = WAL")` returns the mode that SQLite
    // actually engaged; on a few filesystems (network mounts, some mobile
    // FS) SQLite silently keeps DELETE mode — that is still safe, just
    // without read concurrency, so we don't treat it as fatal.
    this.db.pragma("journal_mode = WAL");

    // synchronous = NORMAL under WAL: a commit is acknowledged as soon as the
    // write is handed to the OS, without an fsync per transaction. A process
    // crash never loses committed work (the WAL is replayed); only a power-
    // loss / OS crash can drop the last handful of commits, and it can never
    // corrupt the database. That is the right durability/perf tradeoff for a
    // single-process preview server. (FULL would fsync every commit.)
    this.db.pragma("synchronous = NORMAL");

    // Wait up to 5s on a locked database before raising SQLITE_BUSY. With a
    // single-writer process this mostly covers the WAL checkpoint window
    // during backups and the brief contention between user writes and the
    // realtime/jobs readers.
    this.db.pragma("busy_timeout = 5000");

    // Auto-migrate on open
    if (autoMigrate) {
      this.migrate();
    }

    // Storage engine is created after migrations so the `_files` table exists.
    this.storage = new StorageEngine({
      db: this,
      root: this.dataDir,
      buckets,
    });
  }

  /**
   * Returns the resolved root directory for local file storage. The on-disk
   * storage tree lives at `<dataDir>/storage/`. Used by the backup module to
   * snapshot and restore uploaded files alongside the SQLite database.
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /** Returns the effective auth config, or undefined if auth is not enabled. */
  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  /** Returns true when the `_job_runs` system table has been provisioned. */
  getJobsEnabled(): boolean {
    return this.jobsEnabled;
  }

  /**
   * Enable auth on an already-constructed Database. Provisions the
   * auth system tables if they don't exist. Idempotent
   * — calling it twice is a no-op.
   *
   * This is a convenience for code that constructs the database first and
   * only later learns auth is needed. The more common pattern is to pass
   * `auth` to the `Database` constructor.
   */
  enableAuth(config: AuthConfig): void {
    if (this.authConfig || config.enabled === false) return;
    this.authConfig = { ...config, enabled: true };
    this.effectiveSchema = {
      ...this.schema,
      ...STORAGE_SCHEMA,
      ...(this.jobsEnabled ? JOBS_SCHEMA : {}),
      ...AUTH_SCHEMA,
    };
    this.migrate();
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
