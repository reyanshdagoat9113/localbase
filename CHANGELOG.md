# Changelog

All notable changes to LocalBase publishable packages are documented here.
The four public packages (`@localbase/shared`, `@localbase/core`, `@localbase/sdk`, `@localbase/cli`) share a single version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/) with a beta prerelease line for the developer preview.

## [Unreleased]

### Added

- `localbase status`: a read-only setup check (Node version, database, pending migrations, schema drift, auth, tables without policies, running server). `--json` for scripts.
- `security.trustProxy` option (default `false`): ignores `X-Forwarded-For` in rate limiting and `X-Forwarded-Host`/`X-Forwarded-Proto` in signed storage URLs unless explicitly opted in behind a reverse proxy; rate-limit bucket map is now size-capped.
- `@localbase/core`: engine-agnostic `DbDriver` / `SqlDialect` / `DatabaseError` abstraction (`SqliteDriver`, `sqliteDialect`) and targeted `Database.introspectTable(name)`.
- `@localbase/core`: PostgreSQL driver (`PostgresDriver`, `postgresDialect`, `redactConnectionUrl`) with optional `pg` peer dependency, lazy `import("pg")`, credential redaction on error paths, `information_schema`/`pg_catalog` introspection, and PostgreSQL 16 CI coverage.

### Fixed

- Storage: `POST /api/storage/:bucket/:filename/sign` checks file existence via metadata + `fs.existsSync` without opening an unconsumed read stream (fixing a file-descriptor leak).
- REST API: boolean columns now accept JS `true`/`false` in JSON bodies and `"true"`/`"false"` (in addition to `1`/`0`) in query filters.
- Auth: `setPassword` (and `setPasswordById`) now revokes all active `_sessions` for the user; `setRole` now distinguishes self-demotion from demoting another admin.
- Jobs: `Scheduler.start()` reconciles orphaned `status = "running"` rows from a previous crashed/restarted process as `failed` (`"interrupted: server restarted"`).
- SDK: `update()` / `delete()` now reject additional non-`id` filters instead of silently ignoring them, and URL-encode the `id` path segment.
- Dependencies: updated `hono` and `@hono/node-server` to resolve moderate production audit advisories.
- Release tooling: `scripts/version-set.mjs` now also syncs `VERSION` in `@localbase/shared` and `APP_VERSION` in the landing site.

### Changed

- **Breaking (`@localbase/core`):** `Database` is now async-first (`await Database.open(options)`; CRUD, migration, introspection, auth, storage, and scheduler DB methods return `Promise<T>`). Direct SQLite access is explicitly `database.sqliteRaw()`.
- **Boolean read normalization:** declared `boolean` columns now return JS `true`/`false` on read (SQLite `0`/`1` is normalized at the read boundary) for cross-engine parity.
- **Timestamp defaults:** `default: "CURRENT_TIMESTAMP"` on `text` columns now produces canonical ISO-8601 UTC millisecond strings (`YYYY-MM-DDTHH:MM:SS.mmmZ`, matching `Date.prototype.toISOString()`). Existing SQLite tables created before this change keep their previous `CURRENT_TIMESTAMP` default because additive migrations do not alter existing column defaults.
- **Proxy headers ignored by default (`security.trustProxy: false`):** rate limiting ignores `X-Forwarded-For` and signed storage URLs ignore `X-Forwarded-Host` / `X-Forwarded-Proto` unless explicitly enabled. Behind a reverse proxy, set `security.trustProxy: true`.
- `localbase init` creates a `.gitignore` (`.localbase/`, `backups/`) when none exists, and appends missing entries to an existing one.
- CLI hints print `npx @localbase/cli …` when the CLI was launched through npx, instead of a `localbase` command that isn't on PATH.
- `localbase dev` warns when auth is enabled but tables have no owner policy, since anonymous clients can still read and write them.
- SDK: `update()` / `delete()` without `.eq("id", …)` now return a clear error instead of a JSON parse error, and non-JSON error responses are reported with their status and body.

### Documentation

- REST envelope: successful responses are `{ "data": … }`; the SDK adds `error: null`.

## [0.1.0-beta.2] — 2026-11-04

### Changed

- **Auth is now enabled by default.** `_users`, `_sessions`, and `_admin_requests` are provisioned and `/api/auth/*` is mounted unless the config sets `auth.enabled: false`. Admin Studio gains the matching sign-in / owner-bootstrap flow.
- If a hand-written config omits `jwtSecret`, a random one is generated at startup (sessions do not survive restarts); `localbase init` writes a stable per-project secret.

### Documentation

- User docs live under `docs/` (index, getting started, config, CLI, REST, SDK, auth/RLS, realtime, Storage, Jobs, Admin Studio, core, backup)
- Root README is the product home; package READMEs link to topic docs
- Corrected the realtime SDK surface (`db.subscribe`, not `db.from(...).subscribe`)

## [0.1.0-beta.1] — 2026-08-11

Initial developer-preview beta. Intended first registry publish under the `beta` dist-tag (NPM-P0).

### Features

- Schema-driven SQLite migrations and generated REST CRUD API
- TypeScript SDK (query builder, auth, realtime, Storage)
- CLI (`init`, `dev`, `studio`, migrations, auth/admin helpers, backup/restore, jobs)
- Optional JWT auth with Argon2id passwords and owner-scoped policies
- Realtime WebSocket subscriptions with auth/RLS when auth is enabled
- Local file Storage with private buckets and signed URLs
- Scheduled Jobs with run history
- Embedded Admin Studio SPA
- Package metadata, legal/community files, tarball smoke suite, and prerelease tooling

### Known limitations (developer preview)

- Single-process realtime and job scheduler (not multi-instance)
- No automatic remote/encrypted backups (manual `localbase db backup` / `db restore` only)
- Storage is local-disk only
- Not positioned as a production multi-tenant backend
- Supported Node: `>=22` (CI: Node 22 and 24 on Linux)
- `localbase init` scaffolds the current directory only (no `init <path>`)

### Security notes

- Prefer loopback bind for local dev; configure CORS, TLS termination, and secrets for any non-loopback use
- See `SECURITY.md` for private vulnerability reporting
