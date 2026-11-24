import { AsyncLocalStorage } from "node:async_hooks";
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
 * are completely engine-agnostic.
 *
 * Concurrency model: `better-sqlite3` has a single connection, so every
 * top-level driver operation waits behind any active transaction via `lockChain`.
 * Calls originating inside an active `transaction(fn)` callback are tracked via
 * `AsyncLocalStorage` (or made directly on the `tx` handle) and bypass the lock
 * so they execute inside that transaction without deadlocking. Nested
 * `transaction()` calls inside an active transaction throw immediately.
 */
export class SqliteDriver implements DbDriver {
  readonly dialect = sqliteDialect;
  private readonly rawDb: BetterSqlite3.Database;
  private readonly txContext = new AsyncLocalStorage<QueryExecutor>();
  private lockChain: Promise<void> = Promise.resolve();

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

  private async runLocked<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.txContext.getStore()) {
      return fn();
    }
    const prev = this.lockChain;
    let release!: () => void;
    this.lockChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createTxExecutor(): QueryExecutor {
    return {
      dialect: this.dialect,
      query: async <T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
      ): Promise<T[]> => {
        try {
          return this.rawDb.prepare(sql).all(...params) as T[];
        } catch (err) {
          wrapSqliteError(err);
        }
      },
      queryOne: async <T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
      ): Promise<T | undefined> => {
        try {
          return this.rawDb.prepare(sql).get(...params) as T | undefined;
        } catch (err) {
          wrapSqliteError(err);
        }
      },
      execute: async (
        sql: string,
        params: unknown[] = []
      ): Promise<{ rowCount: number }> => {
        try {
          const info = this.rawDb.prepare(sql).run(...params);
          return { rowCount: info.changes };
        } catch (err) {
          wrapSqliteError(err);
        }
      },
      execBatch: async (sql: string): Promise<void> => {
        try {
          this.rawDb.exec(sql);
        } catch (err) {
          wrapSqliteError(err);
        }
      },
    };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const activeTx = this.txContext.getStore();
    if (activeTx) return activeTx.query<T>(sql, params);
    return this.runLocked(() => {
      try {
        return this.rawDb.prepare(sql).all(...params) as T[];
      } catch (err) {
        wrapSqliteError(err);
      }
    });
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | undefined> {
    const activeTx = this.txContext.getStore();
    if (activeTx) return activeTx.queryOne<T>(sql, params);
    return this.runLocked(() => {
      try {
        return this.rawDb.prepare(sql).get(...params) as T | undefined;
      } catch (err) {
        wrapSqliteError(err);
      }
    });
  }

  async execute(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rowCount: number }> {
    const activeTx = this.txContext.getStore();
    if (activeTx) return activeTx.execute(sql, params);
    return this.runLocked(() => {
      try {
        const info = this.rawDb.prepare(sql).run(...params);
        return { rowCount: info.changes };
      } catch (err) {
        wrapSqliteError(err);
      }
    });
  }

  async execBatch(sql: string): Promise<void> {
    const activeTx = this.txContext.getStore();
    if (activeTx) return activeTx.execBatch(sql);
    return this.runLocked(() => {
      try {
        this.rawDb.exec(sql);
      } catch (err) {
        wrapSqliteError(err);
      }
    });
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    if (this.txContext.getStore()) {
      throw new Error(
        "Nested transactions are not supported on SqliteDriver."
      );
    }

    return this.runLocked(async () => {
      const tx = this.createTxExecutor();
      this.rawDb.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.txContext.run(tx, () => fn(tx));
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
    });
  }

  async introspect(): Promise<IntrospectedSchema> {
    return this.runLocked(() => runIntrospect(this.rawDb));
  }

  async introspectTable(name: string): Promise<IntrospectedTable | null> {
    return this.runLocked(() => runIntrospectTable(this.rawDb, name));
  }

  async tableExists(name: string): Promise<boolean> {
    return this.runLocked(() => {
      const row = this.rawDb
        .prepare(
          `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`
        )
        .get(name);
      return row !== undefined;
    });
  }

  async existingColumns(table: string): Promise<Set<string>> {
    return this.runLocked(() => {
      const rows = this.rawDb
        .prepare(`PRAGMA table_info("${table}")`)
        .all() as { name: string }[];
      return new Set(rows.map((r) => r.name));
    });
  }

  async listUserTables(): Promise<string[]> {
    return this.runLocked(() => {
      const rows = this.rawDb
        .prepare(
          `SELECT "name" FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[];
      return rows.map((r) => r.name).filter((name) => !name.startsWith("_"));
    });
  }

  async dropTablesForReset(tableNames: string[]): Promise<void> {
    return this.runLocked(() => {
      this.rawDb.exec("PRAGMA foreign_keys = OFF");
      try {
        for (const name of tableNames) {
          this.rawDb.exec(`DROP TABLE IF EXISTS "${name}"`);
        }
      } finally {
        this.rawDb.exec("PRAGMA foreign_keys = ON");
      }
    });
  }

  async close(): Promise<void> {
    return this.runLocked(() => {
      this.rawDb.close();
    });
  }
}
