import BetterSqlite3 from "better-sqlite3";
import type { DatabaseSchema } from "@localbase/shared";
import { schemaToDDL } from "./ddl.js";
import { runMigrations, resetDatabase, getAppliedMigrations } from "./migrate.js";
import {
  select,
  selectById,
  insert,
  update,
  remove,
  type Filter,
  type QueryOptions,
} from "./query.js";

export interface DatabaseOptions {
  /** Path to the SQLite file. Use ":memory:" for in-memory databases. */
  path?: string;
  /** The schema definition. */
  schema: DatabaseSchema;
  /** If true, automatically run migrations on open. Default: true. */
  autoMigrate?: boolean;
}

export class Database {
  private db: BetterSqlite3.Database;
  private schema: DatabaseSchema;

  constructor(options: DatabaseOptions) {
    const { path = ":memory:", schema, autoMigrate = true } = options;

    this.db = new BetterSqlite3(path);
    this.schema = schema;

    // Enable foreign keys
    this.db.pragma("foreign_keys = ON");

    // Auto-migrate on open
    if (autoMigrate) {
      this.migrate();
    }
  }

  /**
   * Run pending migrations. Returns the names of newly applied migrations.
   */
  migrate(): string[] {
    return runMigrations(this.db, this.schema);
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
    return resetDatabase(this.db, this.schema);
  }

  /**
   * SELECT rows from a table.
   */
  select(table: string, options?: QueryOptions): unknown[] {
    return select(this.db, table, options);
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
    return insert(this.db, table, data);
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
    return update(this.db, table, data, filters);
  }

  /**
   * DELETE rows matching the given filters.
   * Returns the count of deleted rows.
   */
  delete(table: string, filters?: Filter[]): number {
    return remove(this.db, table, filters);
  }

  /**
   * Get the underlying better-sqlite3 instance for advanced usage.
   */
  raw(): BetterSqlite3.Database {
    return this.db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
