import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, PoolConfig } from "pg";
import type {
  IntrospectedColumn,
  IntrospectedForeignKey,
  IntrospectedIndex,
  IntrospectedSchema,
  IntrospectedTable,
} from "@localbase/shared";
import { isSystemTable } from "../admin/system-tables.js";
import { postgresDialect } from "./dialect-postgres.js";
import {
  DatabaseError,
  normalizeDatabaseError,
  type DbDriver,
  type QueryExecutor,
} from "./types.js";

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PostgresDriverOptions {
  /** PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db`). */
  url: string;
  /** Target PostgreSQL schema. Default: `"public"`. */
  schema?: string;
  /** TLS/SSL configuration passed to `pg.Pool`. */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
  /** Connection pool tuning. */
  pool?: {
    min?: number;
    max?: number;
    idleTimeoutMs?: number;
    connectionTimeoutMs?: number;
  };
}

/**
 * Redact credentials from any PostgreSQL connection URL or error message
 * containing one (`postgres://user:secret@host:5432/db` →
 * `postgres://***@host:5432/db`). Safe to call on arbitrary strings.
 */
export function redactConnectionUrl(input: string): string {
  return input.replace(
    /\b(postgres(?:ql)?:\/\/)([^/\s@]+)@/gi,
    "$1***@"
  );
}

function redactErrorMessage(err: unknown, rawUrl?: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (
    !msg &&
    typeof AggregateError !== "undefined" &&
    err instanceof AggregateError &&
    Array.isArray(err.errors)
  ) {
    msg = err.errors
      .map((inner) => (inner instanceof Error ? inner.message : String(inner)))
      .filter(Boolean)
      .join("; ");
  }
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        msg = msg.split(parsed.password).join("***");
        const decoded = decodeURIComponent(parsed.password);
        if (decoded && decoded !== parsed.password) {
          msg = msg.split(decoded).join("***");
        }
      }
    } catch {
      // Fall through to regex redaction.
    }
  }
  return redactConnectionUrl(msg);
}

function wrapPgError(err: unknown, rawUrl?: string): never {
  if (err instanceof DatabaseError) throw err;
  const safeMessage = redactErrorMessage(err, rawUrl);
  const normalized = normalizeDatabaseError(err, "postgres");
  if (normalized) {
    throw new DatabaseError(normalized.code, safeMessage, "postgres", err);
  }
  throw new DatabaseError("unknown", safeMessage, "postgres", err);
}

function normalizePgColumnType(dataType: string, udtName: string): string {
  const dt = dataType.toLowerCase();
  if (dt === "integer" || udtName === "int4") return "INTEGER";
  if (dt === "bigint" || udtName === "int8") return "BIGINT";
  if (dt === "smallint" || udtName === "int2") return "INTEGER";
  if (dt === "double precision" || dt === "real" || udtName === "float8" || udtName === "float4") {
    return "DOUBLE PRECISION";
  }
  if (dt === "boolean" || udtName === "bool") return "BOOLEAN";
  if (dt === "bytea" || udtName === "bytea") return "BYTEA";
  if (dt === "text" || dt.startsWith("character")) return "TEXT";
  return dataType.toUpperCase();
}

interface ActiveTxState {
  client: PoolClient;
  executor: QueryExecutor;
  active: boolean;
}

/**
 * {@link DbDriver} implementation backed by `pg` (`node-postgres`).
 *
 * Uses lazy `import("pg")` so SQLite-only installations do not require `pg`
 * to be installed. Every pooled client sets `search_path` to the configured
 * schema once on first checkout, and `AsyncLocalStorage` binds all operations
 * inside a `transaction()` callback to the same checked-out `PoolClient`.
 */
export class PostgresDriver implements DbDriver {
  readonly dialect = postgresDialect;
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly rawUrl: string;
  private readonly txContext = new AsyncLocalStorage<ActiveTxState>();
  private readonly initializedClients = new WeakSet<PoolClient>();

  private constructor(pool: Pool, schema: string, rawUrl: string) {
    this.pool = pool;
    this.schema = schema;
    this.rawUrl = rawUrl;
  }

  /**
   * Lazily load `pg`, construct a `Pool`, verify connectivity, and return a
   * ready {@link PostgresDriver}. All errors redact connection credentials.
   */
  static async connect(options: PostgresDriverOptions): Promise<PostgresDriver> {
    const schema = options.schema ?? "public";
    if (!IDENT_RE.test(schema)) {
      throw new DatabaseError(
        "invalid_input",
        `Invalid PostgreSQL schema name: "${schema}"`,
        "postgres"
      );
    }
    if (!options.url || typeof options.url !== "string") {
      throw new DatabaseError(
        "connection",
        "PostgreSQL connection URL is required.",
        "postgres"
      );
    }

    let pgModule: typeof import("pg");
    try {
      pgModule = await import("pg");
    } catch (err) {
      throw new DatabaseError(
        "connection",
        'PostgreSQL driver "pg" is not installed. Install it to use the PostgreSQL adapter: npm install pg',
        "postgres",
        err
      );
    }

    const PoolCtor =
      pgModule.Pool ?? (pgModule as unknown as { default?: { Pool?: typeof Pool } }).default?.Pool;
    if (!PoolCtor) {
      throw new DatabaseError(
        "connection",
        'Could not resolve Pool constructor from "pg" package.',
        "postgres"
      );
    }

    const poolConfig: PoolConfig = {
      connectionString: options.url,
      ssl: options.ssl,
      min: options.pool?.min,
      max: options.pool?.max,
      idleTimeoutMillis: options.pool?.idleTimeoutMs,
      connectionTimeoutMillis: options.pool?.connectionTimeoutMs,
    };

    const pool = new PoolCtor(poolConfig);
    const driver = new PostgresDriver(pool, schema, options.url);

    // Verify connectivity up-front and redact credentials on any failure.
    try {
      const client = await pool.connect();
      try {
        await driver.ensureSearchPath(client);
      } finally {
        client.release();
      }
    } catch (err) {
      await pool.end().catch(() => {});
      const safeMessage = redactErrorMessage(err, options.url);
      throw new DatabaseError(
        "connection",
        `Failed to connect to PostgreSQL (${redactConnectionUrl(options.url)}): ${safeMessage}`,
        "postgres",
        err
      );
    }

    return driver;
  }

  private async ensureSearchPath(client: PoolClient): Promise<void> {
    if (this.initializedClients.has(client)) return;
    await client.query(`SET search_path TO "${this.schema}"`);
    this.initializedClients.add(client);
  }

  private getActiveTx(): ActiveTxState | undefined {
    const store = this.txContext.getStore();
    return store?.active === true ? store : undefined;
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const active = this.getActiveTx();
    if (active) {
      return fn(active.client);
    }
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      wrapPgError(err, this.rawUrl);
    }
    try {
      await this.ensureSearchPath(client);
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private createTxExecutor(state: ActiveTxState): QueryExecutor {
    const assertActive = (): void => {
      if (!state.active) {
        throw new Error("Transaction has already finished.");
      }
    };
    return {
      dialect: this.dialect,
      query: async <T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
      ): Promise<T[]> => {
        assertActive();
        try {
          const res = await state.client.query(sql, params);
          return res.rows as T[];
        } catch (err) {
          wrapPgError(err, this.rawUrl);
        }
      },
      queryOne: async <T = Record<string, unknown>>(
        sql: string,
        params: unknown[] = []
      ): Promise<T | undefined> => {
        assertActive();
        try {
          const res = await state.client.query(sql, params);
          return res.rows[0] as T | undefined;
        } catch (err) {
          wrapPgError(err, this.rawUrl);
        }
      },
      execute: async (
        sql: string,
        params: unknown[] = []
      ): Promise<{ rowCount: number }> => {
        assertActive();
        try {
          const res = await state.client.query(sql, params);
          return { rowCount: res.rowCount ?? 0 };
        } catch (err) {
          wrapPgError(err, this.rawUrl);
        }
      },
      execBatch: async (sql: string): Promise<void> => {
        assertActive();
        try {
          await state.client.query(sql);
        } catch (err) {
          wrapPgError(err, this.rawUrl);
        }
      },
    };
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    return this.withClient(async (client) => {
      try {
        const res = await client.query(sql, params);
        return res.rows as T[];
      } catch (err) {
        wrapPgError(err, this.rawUrl);
      }
    });
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | undefined> {
    return this.withClient(async (client) => {
      try {
        const res = await client.query(sql, params);
        return res.rows[0] as T | undefined;
      } catch (err) {
        wrapPgError(err, this.rawUrl);
      }
    });
  }

  async execute(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rowCount: number }> {
    return this.withClient(async (client) => {
      try {
        const res = await client.query(sql, params);
        return { rowCount: res.rowCount ?? 0 };
      } catch (err) {
        wrapPgError(err, this.rawUrl);
      }
    });
  }

  async execBatch(sql: string): Promise<void> {
    return this.withClient(async (client) => {
      try {
        await client.query(sql);
      } catch (err) {
        wrapPgError(err, this.rawUrl);
      }
    });
  }

  async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    if (this.getActiveTx()) {
      throw new Error(
        "Nested transactions are not supported on PostgresDriver."
      );
    }

    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      wrapPgError(err, this.rawUrl);
    }

    const state: ActiveTxState = {
      client,
      executor: null as unknown as QueryExecutor,
      active: true,
    };
    state.executor = this.createTxExecutor(state);

    try {
      await this.ensureSearchPath(client);
      await client.query("BEGIN");
      try {
        const result = await this.txContext.run(state, () => fn(state.executor));
        state.active = false;
        await client.query("COMMIT");
        return result;
      } catch (err) {
        state.active = false;
        try {
          await client.query("ROLLBACK");
        } catch {
          // Best-effort rollback.
        }
        throw err;
      }
    } finally {
      state.active = false;
      client.release();
    }
  }

  async introspect(): Promise<IntrospectedSchema> {
    const tables = await this.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [this.schema]
    );

    const result: IntrospectedTable[] = [];
    for (const row of tables) {
      const table = await this.introspectTableInternal(row.table_name, true);
      if (table) result.push(table);
    }
    return { tables: result };
  }

  async introspectTable(name: string): Promise<IntrospectedTable | null> {
    return this.introspectTableInternal(name, false);
  }

  private async introspectTableInternal(
    name: string,
    includeRowCount: boolean
  ): Promise<IntrospectedTable | null> {
    const exists = await this.tableExists(name);
    if (!exists) return null;

    const colRows = await this.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [this.schema, name]
    );

    const pkRows = await this.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
       WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [this.schema, name]
    );
    const pkSet = new Set(pkRows.map((r) => r.column_name));

    const columns: IntrospectedColumn[] = colRows.map((c) => {
      const primaryKey = pkSet.has(c.column_name);
      const isIdentity = c.is_identity === "YES";
      const isSerial =
        typeof c.column_default === "string" &&
        c.column_default.startsWith("nextval(");
      return {
        name: c.column_name,
        type: normalizePgColumnType(c.data_type, c.udt_name),
        notNull: c.is_nullable === "NO" || primaryKey,
        primaryKey,
        autoIncrement: isIdentity || isSerial,
        defaultValue: c.column_default,
      };
    });

    const primaryKey = pkRows.map((r) => r.column_name);

    const fkRows = await this.query<{
      from_column: string;
      to_table: string;
      to_column: string;
    }>(
      `SELECT
         kcu.column_name AS from_column,
         ccu.table_name AS to_table,
         ccu.column_name AS to_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1
         AND tc.table_name = $2`,
      [this.schema, name]
    );
    const foreignKeys: IntrospectedForeignKey[] = fkRows.map((fk) => ({
      fromColumn: fk.from_column,
      toTable: fk.to_table,
      toColumn: fk.to_column,
    }));

    const idxRows = await this.query<{
      index_name: string;
      is_unique: boolean;
      column_name: string;
    }>(
      `SELECT
         ic.relname AS index_name,
         i.indisunique AS is_unique,
         a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
       WHERE n.nspname = $1
         AND c.relname = $2
         AND NOT i.indisprimary
       ORDER BY ic.relname, array_position(i.indkey, a.attnum)`,
      [this.schema, name]
    );

    const idxMap = new Map<string, IntrospectedIndex>();
    for (const row of idxRows) {
      let entry = idxMap.get(row.index_name);
      if (!entry) {
        entry = { name: row.index_name, unique: row.is_unique, columns: [] };
        idxMap.set(row.index_name, entry);
      }
      entry.columns.push(row.column_name);
    }

    let rowCount = 0;
    if (includeRowCount) {
      const countRow = await this.queryOne<{ n: string | number }>(
        `SELECT COUNT(*) AS n FROM "${this.schema}"."${name}"`
      );
      rowCount = Number(countRow?.n ?? 0);
    }

    return {
      name,
      columns,
      primaryKey,
      foreignKeys,
      indexes: [...idxMap.values()],
      rowCount,
      system: isSystemTable(name),
      virtual: false,
    };
  }

  async tableExists(name: string): Promise<boolean> {
    const row = await this.queryOne<{ x: number }>(
      `SELECT 1 AS x
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [this.schema, name]
    );
    return row !== undefined;
  }

  async existingColumns(table: string): Promise<Set<string>> {
    const rows = await this.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [this.schema, table]
    );
    return new Set(rows.map((r) => r.column_name));
  }

  async listUserTables(): Promise<string[]> {
    const rows = await this.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [this.schema]
    );
    return rows.map((r) => r.table_name).filter((name) => !name.startsWith("_"));
  }

  async dropTablesForReset(tableNames: string[]): Promise<void> {
    if (tableNames.length === 0) return;
    await this.transaction(async (tx) => {
      for (const name of tableNames) {
        await tx.execBatch(
          `DROP TABLE IF EXISTS "${this.schema}"."${name}" CASCADE`
        );
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
