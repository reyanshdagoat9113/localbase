# 🐘 LocalBase PostgreSQL Support — Architecture & Integration Plan

> **Status: proposed plan (not yet implemented).**  
> **Scope:** Opt-in PostgreSQL backend alongside the existing SQLite engine.  
> **Non-negotiable invariant:** SQLite (`better-sqlite3`) remains the zero-config default. A developer running `npx @localbase/cli init && localbase dev` must never need Docker, Postgres, or a connection string.

---

## 🎯 Why add PostgreSQL as an option?

LocalBase's core strength is zero-setup local development with SQLite. However, teams adopting LocalBase for larger or longer-lived apps hit predictable ceilings:

- **Concurrent writes:** SQLite allows one writer at a time; write-heavy workloads or multiple app processes benefit from Postgres MVCC and connection pooling.
- **Production parity:** Teams deploying to Postgres (RDS, Neon, Supabase, Railway, self-hosted) want the same SQL engine locally and in staging/production.
- **Scale & ops ecosystem:** Postgres brings mature backup tooling (`pg_dump`/PITR), extensions, roles, and a path to multi-instance deployments (via `LISTEN/NOTIFY` and advisory locks in a later phase).

Adding PostgreSQL as an **opt-in adapter** lets projects start on SQLite and switch to Postgres via config when they outgrow a single embedded file—without rewriting their schema, REST API, SDK calls, auth, RLS policies, or Admin Studio workflows.

---

## 📌 Thesis

Introduce a small, internal **`DbDriver` + `SqlDialect`** abstraction inside `@localbase/core` that cleanly separates SQLite (`better-sqlite3`) from PostgreSQL (`pg`). Make `Database` async-first across both engines, eliminate all internal `db.raw()` calls in `auth`, `storage`, `jobs`, `admin`, and `migrate`, and expose PostgreSQL as an opt-in `database` block in `localbase.config.ts` (or `DATABASE_URL`).

---

## ✅ Decision Record (locked for M1–M2)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Default engine** | **SQLite (`better-sqlite3`) remains the default** whenever `database` is omitted or `client: "sqlite"`. | Preserves the zero-config, no-Docker onboarding story. |
| 2 | **Postgres driver** | `pg` (`node-postgres`) via `pg.Pool`, declared as an **optional peer dependency** (`peerDependencies` + `peerDependenciesMeta.optional: true`) with lazy `import("pg")` and a clear install error. | Battle-tested across RDS, Neon, Cloud SQL, Railway, and local Postgres; keeps SQLite-only installs free of Postgres deps. |
| 3 | **Async `Database` API** | Convert `Database` to async (`await Database.open(options)`, all CRUD/migration/introspection/close methods return `Promise<T>`). | `pg` is inherently async. Hono route handlers, Auth, Storage, Jobs, and CLI commands are already `async`. Best done while in `0.1.0-beta.x`. |
| 4 | **Config shape** | Add `database?: DatabaseConfig` to `LocalBaseConfig` in `@localbase/shared` (see below). | Mirrors `auth`, `storage`, `jobs`, `security` config blocks. Supports `DATABASE_URL` env fallback so secrets stay out of `localbase.config.ts`. |
| 5 | **Parameter placeholders** | Standardize internal query builders on **positional parameters**, formatted via `dialect.placeholder(index)` (`?` for SQLite, `$1` for Postgres). | Eliminates `@named` (`better-sqlite3`-specific) placeholders in `query.ts` and makes every query portable. |
| 6 | **Transactions** | Replace `db.raw().transaction(fn)` with `await driver.transaction(async (tx) => ...)`. | On SQLite, serializes async transactions with `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. On Postgres, checks out a dedicated `PoolClient`. |
| 7 | **Error normalization** | Map engine-specific constraint errors (SQLite `SQLITE_CONSTRAINT_*`, Postgres SQLSTATE `23505`/`23503`/`23502`/`22P02`) to a shared `DatabaseError` with typed `code`. | Replaces the 3 duplicated `SQLITE_CONSTRAINT_*` checks (`api.ts`, `admin/router.ts`, `auth.ts`) and guarantees identical HTTP responses (`409`, `400`). |
| 8 | **Boolean normalization** | Normalize `boolean` columns to JS `true`/`false` on **both** engines at the read boundary (SQLite `0`/`1` → `boolean`). Writes use dialect-aware coercion (`1`/`0` on SQLite, `true`/`false` on Postgres). | Guarantees identical REST/SDK shapes across engines. Documented as a breaking/visible change in `CHANGELOG.md`. |
| 9 | **Timestamp parity** | Keep `type: "text"` for system timestamps, and have both engines write identical ISO-8601 UTC millisecond strings (`YYYY-MM-DDTHH:MM:SS.mmmZ`, matching `Date.prototype.toISOString()`) via dialect-normalized `CURRENT_TIMESTAMP` defaults. | Avoids engine-specific `CURRENT_TIMESTAMP` formatting differences and matches app-written `toISOString()` values. |
| 10 | **`COUNT(*)` parity** | Coerce `COUNT(*)` to JS `number` in the driver/query layer (`pg` returns `bigint` as string). | Prevents subtle type mismatches in `db.count()` and Admin Studio. |
| 11 | **`LIKE` semantics** | Keep SQL `LIKE` as-is and document the case-sensitivity difference (SQLite ASCII case-insensitive vs Postgres case-sensitive); do not rewrite queries. | Predictable SQL semantics without hidden query rewrites. |
| 12 | **Additive migration rules** | Keep the same additive-only migration contract across both engines. | Preserves schema portability between SQLite and Postgres. |
| 13 | **Credential hygiene** | Redact credentials (`postgres://***@host:port/db`) in logs, `status`, and **every error path** (including connection failures). | Prevents accidental secret leaks in terminals and CI logs. |
| 14 | **Out of scope for v1** | Multi-instance Realtime (`LISTEN/NOTIFY`), distributed job locking (advisory locks), S3/object storage, and SQLite→Postgres live data replication. | Keeps v1 focused on single-process engine parity; those layer on cleanly afterward. |

---

## ⚙️ Proposed Configuration Surface

In `packages/shared/src/index.ts`:

```ts
export type DatabaseConfig =
  | {
      client?: "sqlite";
      /** Optional custom SQLite file path. Defaults to `.localbase/data.db`. */
      path?: string;
    }
  | {
      client: "postgres";
      /** Connection string. Falls back to `process.env.DATABASE_URL`. */
      url?: string;
      /** Postgres schema to use. Default: "public". */
      schema?: string;
      /** TLS/SSL config passed to `pg.Pool`. */
      ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
      /** Pool tuning for larger workloads. */
      pool?: {
        min?: number;
        max?: number;
        idleTimeoutMs?: number;
        connectionTimeoutMs?: number;
      };
    };
```

Example `localbase.config.ts`:

```ts
export default {
  database: {
    client: "postgres",
    url: process.env.DATABASE_URL, // e.g. postgres://user:pass@localhost:5432/myapp
    pool: { max: 20 },
  },
  tables: {
    posts: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      published: { type: "boolean", default: "false" },
    },
  },
};
```

---

## 🏗️ Architecture & Dialect Mapping

### 1. Driver & Dialect Layer (`packages/core/src/db/`)

```
packages/core/src/db/
  types.ts             # DbDriver, DbTransaction, QueryResult, DatabaseError, SqlDialect
  dialect-sqlite.ts    # SQLite type map, `?` placeholders, PRAGMA/sqlite_master introspection
  dialect-postgres.ts  # Postgres type map, `$1` placeholders, information_schema/pg_catalog introspection
  driver-sqlite.ts     # Wraps better-sqlite3 behind DbDriver (async interface)
  driver-postgres.ts   # Wraps pg.Pool behind DbDriver (lazy dynamic import of "pg")
  index.ts             # Factory: createDriver(config)
```

Core `DbDriver` interface (minimal, focused):

```ts
export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  execBatch(sql: string): Promise<void>;
}

export interface DbDriver extends QueryExecutor {
  readonly dialect: SqlDialect;
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  introspect(): Promise<IntrospectedSchema>;
  listUserTables(): Promise<string[]>;
  existingColumns(table: string): Promise<Set<string>>;
  tableExists(table: string): Promise<boolean>;
  dropTablesForReset(tableNames: string[]): Promise<void>;
  close(): Promise<void>;
}
```

### 2. SQL Dialect Differences to Handle

| Area | SQLite (`better-sqlite3`) | PostgreSQL (`pg`) |
|---|---|---|
| **Placeholders** | `?` | `$1, $2, ...` |
| **Auto-increment PK** | `"id" INTEGER PRIMARY KEY AUTOINCREMENT` | `"id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` |
| **`integer`** | `INTEGER` | `INTEGER` |
| **`text`** | `TEXT` | `TEXT` |
| **`real`** | `REAL` | `DOUBLE PRECISION` |
| **`blob`** | `BLOB` | `BYTEA` |
| **`boolean`** | `INTEGER` (0 / 1) | `BOOLEAN` (`true` / `false`) |
| **Boolean defaults** | `0` / `1` (normalize `'true'`/`'false'`) | `TRUE` / `FALSE` (normalize `0`/`1`) |
| **`_migrations.applied_at`** | `TEXT NOT NULL DEFAULT (datetime('now'))` | `TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` (or standardize both on `CURRENT_TIMESTAMP`) |
| **`RETURNING *`** | Supported (SQLite ≥ 3.35) | Supported natively |
| **Bulk `INSERT`** | Loop in transaction (or multi-row `VALUES`) | Single multi-row `INSERT INTO ... VALUES ($1,$2),($3,$4) RETURNING *` inside transaction |
| **`COUNT(*)`** | Returns `number` | Returns `string` (`bigint`) → coerce via `Number(row.n)` |
| **Introspection** | `sqlite_master` + `PRAGMA table_info / foreign_key_list / index_list / table_list` | `information_schema.tables/columns` + `pg_catalog` (`pg_constraint`, `pg_index`, `pg_class`) scoped to `schema` (default `public`) |
| **Reset (`db reset`)** | `PRAGMA foreign_keys = OFF` + `DROP TABLE IF EXISTS "..."` | `DROP TABLE IF EXISTS "schema"."table" CASCADE` inside transaction (still preserving `_`-prefixed system tables) |
| **Constraint errors** | `err.code` (`SQLITE_CONSTRAINT_UNIQUE`, etc.) | `err.code` (`23505` unique, `23503` FK, `23502` not-null, `22P02` invalid syntax) |
| **Session setup** | `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000` | `SET search_path TO "<schema>"` on pool connect + optional statement timeout |

---

## 🔍 Exact Codebase Touchpoints

Every non-test file in the repository that currently couples directly to `better-sqlite3` or SQLite syntax:

1. **`packages/shared/src/index.ts`**
   - Add `DatabaseConfig` and optional `database?: DatabaseConfig` on `LocalBaseConfig`.
2. **`packages/core/src/db.ts`**
   - Replace `new BetterSqlite3(path)` in constructor with async `Database.open(options)` (keeping a clear migration note or thin wrapper).
   - Delegate CRUD, `migrate`, `reset`, `introspect`, and `close` to `DbDriver`.
   - Deprecate/remove `raw()` from cross-engine paths (or expose `sqliteRaw()` only when `client === "sqlite"`).
3. **`packages/core/src/ddl.ts`**
   - Parameterize `columnToDDL`, `columnToAddDDL`, `tableToDDL`, `schemaToDDL` by `SqlDialect`.
   - Normalize boolean/timestamp defaults across dialects.
4. **`packages/core/src/query.ts`**
   - Replace `@named` placeholders with positional parameters via `dialect.placeholder(i)`.
   - Make `select`, `count`, `selectById`, `insert`, `update`, `remove` async and accept `QueryExecutor` + `SqlDialect`.
5. **`packages/core/src/migrate.ts`**
   - Use `driver.transaction`, `driver.existingColumns`, `driver.dropTablesForReset`, and dialect-aware `_migrations` table DDL (replace `datetime('now')` and `AUTOINCREMENT`).
6. **`packages/core/src/admin/introspect.ts`**
   - Move SQLite `PRAGMA` logic into `SqliteDriver.introspect()`, add Postgres `pg_catalog`/`information_schema` implementation in `PostgresDriver.introspect()`.
7. **`packages/core/src/admin/router.ts`** *(2 `.raw()` calls at lines 198, 664)*
   - Route through `Database` / `DbDriver` methods and `await` them.
8. **`packages/core/src/auth/auth.ts`** *(7 `.raw()` calls at lines 252, 316, 342, 400, 608, 617, 638)*
   - Replace `.raw().transaction(...)` and `.raw().prepare(...)` with `db.transaction(...)` and dialect-safe queries.
9. **`packages/core/src/storage/engine.ts`** *(7 `.raw()` calls at lines 143, 208, 231, 250, 272, 314, 321)*
   - Replace `.raw().prepare(...)` and `sqlite_master` check with `driver.tableExists("_files")` and `driver.query`/`execute`.
10. **`packages/core/src/jobs/scheduler.ts`** *(2 `.raw()` calls at lines 307, 317)*
    - Replace `sqlite_master` check and raw index creation with `driver.tableExists("_job_runs")` and `driver.execBatch(...)`.
11. **`packages/core/src/backup.ts`**
    - Branch on engine: keep existing SQLite online backup API for SQLite; handle Postgres cleanly (see M4).
12. **`packages/cli/src/{config,dev,db,auth,admin,jobs,status,init}.ts`**
    - Resolve `config.database` + `DATABASE_URL`, `await Database.open(...)`, call `await db.close()` on exit/reload, and display redacted engine info in `localbase status` and `localbase dev`.

---

## 🗺️ Phased Milestones

### M1 — Driver Abstraction & Async `Database` Refactor (SQLite-only, zero behavior change except boolean read normalization)
- Define `DbDriver`, `QueryExecutor`, `SqlDialect`, and `DatabaseError` in `packages/core/src/db/`.
- Implement `SqliteDriver` and `SqliteDialect` wrapping `better-sqlite3` (with explicit SQLite-only `sqliteRaw()` for `backup.ts`).
- Convert `query.ts`, `ddl.ts`, `migrate.ts`, `db.ts` to use `DbDriver` + `SqlDialect` and async methods (`await Database.open(...)`).
- Normalize `boolean` columns to JS `true`/`false` on read, and make REST/admin boolean writes dialect-aware (`1`/`0` on SQLite, `true`/`false` on Postgres).
- Normalize `CURRENT_TIMESTAMP` defaults on `text` columns to ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`).
- Replace all 3 `SQLITE_CONSTRAINT_*` checks (`api.ts`, `admin/router.ts`, `auth.ts`) with the shared `DatabaseError` normalizer.
- Remove all internal `db.raw()` calls in `auth.ts`, `storage/engine.ts`, `jobs/scheduler.ts`, and `admin/router.ts`.
- Make refresh-token rotation (`Auth.refresh()`) atomic (`DELETE ... WHERE token = ? RETURNING *` / transaction) so concurrent refreshes with one token cannot both mint sessions.
- Make `Scheduler.triggerNow()` async and await the initial `"running"` row insert before returning `runId`; update admin trigger route.
- Make `liveAdminRole` / `isLiveAdmin` async and serialize per-client realtime event delivery so role-cache refreshes cannot reorder events.
- Validate/coerce `:id` path params against the PK column type in `api.ts` and `admin/router.ts` (`400`/`404` instead of Postgres `22P02` → `500`).
- Add targeted `introspectTable(name)` so admin row endpoints introspect only the target table instead of `introspect()` + `COUNT(*)` on all tables.
- Update `api.ts`, `rls.ts`, `realtime/`, `cli/`, `scripts/pack-smoke.mjs`, and existing test suites to `await` DB operations.
- **Gate:** All existing unit, integration, CLI, SDK, and Playwright E2E tests pass on SQLite with zero regressions (plus new tests for boolean normalization, ISO-8601 timestamps, concurrent refresh rotation, realtime ordering, `:id` validation, and `introspectTable`).

### M2 — `PostgresDriver`, `PostgresDialect` & Postgres CI Job
- Add optional peer dependency `pg` (`peerDependenciesMeta.optional: true`) and `@types/pg` devDep to `packages/core`.
- Implement `PostgresDriver` using `pg.Pool` with lazy `import("pg")`, clear install error when `pg` is absent, and credential redaction in all error paths (including connection failures).
- Implement `PostgresDialect`:
  - `$1`-based placeholders
  - Type mapping (`GENERATED BY DEFAULT AS IDENTITY`, `DOUBLE PRECISION`, `BYTEA`, `BOOLEAN`)
  - Default value normalization (ISO-8601 UTC `CURRENT_TIMESTAMP`, booleans)
  - `information_schema` + `pg_catalog` introspection (`introspect()` and `introspectTable(name)`) returning the exact `IntrospectedSchema` shape expected by Admin Studio
  - `DROP TABLE ... CASCADE` reset preserving `_`-prefixed system tables
  - SQLSTATE → `DatabaseError` mapping (`23505`, `23503`, `23502`, `22P02`)
  - Transaction checkout/release safety on `PoolClient`
- Add a Postgres 16 service container job to `.github/workflows/ci.yml` running core `db`, `migrate`, `query`, and `introspect` suites with `TEST_POSTGRES_URL` (isolating tests with a unique schema per run).
- Keep the pack smoke check proving `@localbase/core` installs and runs on SQLite **without** `pg` installed.
- **Gate:** Core `db`, `migrate`, `query`, and `introspect` suites pass against PostgreSQL 16 in CI, and SQLite-only installs work without `pg`.

### M3 — Config, CLI & Lifecycle Integration
- Add `DatabaseConfig` to `@localbase/shared` and validation in `packages/cli/src/config.ts` (including `DATABASE_URL` env resolution and SSL/pool validation).
- Wire `Database.open()` in `dev.ts`, `db.ts`, `auth.ts`, `admin.ts`, `jobs.ts`, `status.ts`.
- Ensure config hot-reload in `localbase dev` cleanly drains `pool.end()` before reopening, and `SIGINT`/`SIGTERM` closes the pool gracefully.
- Update `localbase status` and `localbase dev` startup banner to show the active engine (`SQLite (.localbase/data.db)` vs `PostgreSQL (host:port/db, schema: public)`) with credentials redacted.
- Optional: add `--db postgres` flag to `localbase init` to scaffold a `database: { client: "postgres", url: process.env.DATABASE_URL }` config stub.
- **Gate:** Full CLI flow (`init`, `dev`, `db migrate`, `db reset`, `status`, `auth`, `admin:promote`, `jobs`) works end-to-end on both SQLite and Postgres.

### M4 — Backup/Restore & Operational Guardrails
- Extend `BackupManifest` with `engine: "sqlite" | "postgres"` (backwards-compatible: missing `engine` defaults to `"sqlite"`).
- For `localbase db backup` / `restore` on Postgres:
  - Option A (recommended for v1): shell out to `pg_dump --format=custom` / `pg_restore` when available on `PATH`, bundling the dump + `storage/` + SHA-256 `manifest.json`, with a clear error message if `pg_dump`/`pg_restore` is missing.
  - Option B (minimal v1): refuse cleanly with a typed `BackupError` explaining that Postgres backups use `pg_dump` + `.localbase/storage/` copy.
- Add startup connectivity check with a concise error if Postgres is unreachable or auth fails.
- **Gate:** Backup/restore tests cover manifest compatibility and Postgres behavior; unreachable-DB errors are clear and never leak credentials.

### M5 — Dual-Engine Test Suite & CI Matrix
- Create a shared test-harness helper (`createTestDatabase`) that runs core integration suites (`db`, `migrate`, `api`, `auth`, `rls`, `storage`, `jobs`, `admin`, `realtime`) against SQLite by default, and also against PostgreSQL when `TEST_POSTGRES_URL` is set (isolating each test with a unique Postgres schema or database).
- Add a Postgres 16 service container job to `.github/workflows/ci.yml` running the parameterized suite.
- Add tarball/pack smoke check verifying `@localbase/core` still installs and runs on SQLite **without** `pg` installed.
- **Gate:** CI is green for both SQLite (Linux/macOS/Windows) and Postgres (Linux service container), and SQLite-only installs do not require `pg`.

### M6 — Documentation & Migration Guide
- Update `docs/CONFIG.md`, `docs/CORE.md`, `docs/CLI.md`, `docs/BACKUP-AND-RECOVERY.md`, and `README.md` with PostgreSQL setup, pool/SSL options, and dialect caveats.
- Add a **SQLite → PostgreSQL guide** covering config switching, `localbase db migrate`, and exporting/importing existing data.
- Update `TASKS.md` and `LOCALBASE.md` to link to this plan.

---

## 🔮 Future Follow-ups (Enabled by Postgres, Separate Plans)

Once M1–M6 ship, PostgreSQL unlocks multi-instance features that were previously impossible on single-file SQLite:
- **Multi-instance Realtime:** Publish/subscribe row-change events via Postgres `LISTEN/NOTIFY` (or Redis) so multiple LocalBase nodes fan out WebSocket events.
- **Distributed Scheduled Jobs:** Use `pg_try_advisory_lock` so only one instance runs a scheduled cron firing.
- **Pluggable Object Storage:** S3/R2-compatible storage adapter alongside local disk so multiple instances share uploaded files.

---

## ⚠️ Key Risks & Open Questions

1. **Breaking `@localbase/core` sync API:** Programmatic callers of `new Database(...)` and `db.select(...)` will need to migrate to `await Database.open(...)` / `await db.select(...)`. Acceptable while in `0.1.0-beta.x`, but should be clearly called out in `CHANGELOG.md`.
2. **Timestamp representation:** System tables (`_users`, `_sessions`, `_files`, `_job_runs`) currently declare `created_at`/`started_at`/`uploaded_at` as `type: "text"` with `default: "CURRENT_TIMESTAMP"`. On Postgres, `TEXT DEFAULT CURRENT_TIMESTAMP` works, though the format differs slightly from SQLite (`2026-11-24 13:30:00+00` vs `2026-11-24 13:30:00`). Decide in M2 whether to keep `TEXT` with normalized ISO-8601 defaults or introduce a first-class `"timestamp"` column type later.
3. **Boolean representation in REST/SDK:** SQLite stores booleans as `0`/`1`, while Postgres returns JS `true`/`false`. Decide in M2 whether to normalize SQLite boolean columns to `true`/`false` at the query layer or document the difference.
4. **Optional peer dep vs direct dep:** Making `pg` an optional peer dependency keeps SQLite installs light, while making it a direct dependency avoids an extra `npm install pg` step. Recommend **optional peer dependency** with a clear install prompt on first Postgres use.
