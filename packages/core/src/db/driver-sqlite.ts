import BetterSqlite3 from "better-sqlite3";
import type {
  IntrospectedSchema,
  IntrospectedTable,
} from "@localbase/shared";
import {
  introspect as runIntrospect,
  introspectTable as runIntrospectTable,
} from "../admin/introspect.js";
import { sqliteDialect } from "./dialect-sqlite.js";
import {
  normalizeDatabaseError,
  type DbDriver,
  type QueryExecutor,
} from "./types.js";

function wrapSqliteError(err: unknown): never {
  const normalized = normalizeDatabaseError(err, "sqlite");
  if (normalized) throw normalized;
  throw err;
}

/**
 * {@link DbDriver} implementation backed by `better-sqlite3`.
 *
 * Exposes an async interface matching {@link PostgresDriver} so higher layers
 * are completely engine-agnostic. Async transactions are serialized through a
 * per-driver promise queue using `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` so
 * concurrent callers cannot collide with SQLite's single-writer transaction
 * model.
 */
export class SqliteDriver implements DbDriver {
  readonly dialect = sqliteDialect;
  private readonly rawDb: BetterSqlite3.Database;
  private txChain: Promise<void> = Promise.resolve();

  constructor(path: string = ":memory:") {
    this.rawDb = new BetterSqlite3(path);
    this.rawDb.pragma("foreign_keys = ON");
    this.rawDb.pragma("journal_mode = WAL");
    this.rawDb.pragma("synchronous = NORMAL");
    this.rawDb.pragma("busy_timeout = 5000");
  }

  /**
   * Direct `better-sqlite3` handle. Exposed solely for SQLite-specific
   * operations (e.g. online backup API in `backup.ts`) and SQLite unit tests.
   */
  sqliteRaw(): BetterSqlite3.Database {
    return this.rawDb;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    try {
      return this.rawDb.prepare(sql).all(...params) as T[];
    } catch (err) {
      wrapSqliteError(err);
    }
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | undefined> {
    try {
      return this.rawDb.prepare(sql).get(...params) as T | undefined;
    } catch (err) {
      wrapSqliteError(err);
    }
  }

  async execute(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rowCount: number }> {
    try {
      const info = this.rawDb.prepare(sql).run(...params);
      return { rowCount: info.changes };
    } catch (err) {
      wrapSqliteError(err);
    }
  }

  async execBatch(sql: string): Promise<void> {
    try {
      this.rawDb.exec(sql);
    } catch (err) {
      wrapSqliteError(err);
    }
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    const prev = this.txChain;
    let release!: () => void;
    this.txChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    try {
      this.rawDb.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        this.rawDb.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          if (this.rawDb.inTransaction) {
            this.rawDb.exec("ROLLBACK");
          }
        } catch {
          // Best-effort rollback.
        }
        throw err;
      }
    } finally {
      release();
    }
  }

  async introspect(): Promise<IntrospectedSchema> {
    return runIntrospect(this.rawDb);
  }

  async introspectTable(name: string): Promise<IntrospectedTable | null> {
    return runIntrospectTable(this.rawDb, name);
  }

  async tableExists(name: string): Promise<boolean> {
    const row = this.rawDb
      .prepare(
        `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`
      )
      .get(name);
    return row !== undefined;
  }

  async existingColumns(table: string): Promise<Set<string>> {
    const rows = this.rawDb
      .prepare(`PRAGMA table_info("${table}")`)
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  async listUserTables(): Promise<string[]> {
    const rows = this.rawDb
      .prepare(
        `SELECT "name" FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' AND name NOT LIKE 'sqlite_%'`
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name).filter((name) => !name.startsWith("_"));
  }

  async dropTablesForReset(tableNames: string[]): Promise<void> {
    this.rawDb.exec("PRAGMA foreign_keys = OFF");
    try {
      for (const name of tableNames) {
        this.rawDb.exec(`DROP TABLE IF EXISTS "${name}"`);
      }
    } finally {
      this.rawDb.exec("PRAGMA foreign_keys = ON");
    }
  }

  async close(): Promise<void> {
    this.rawDb.close();
  }
}
