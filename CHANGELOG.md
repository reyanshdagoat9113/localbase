# Changelog

All notable changes to LocalBase publishable packages are documented here.
The four public packages (`@localbase/shared`, `@localbase/core`, `@localbase/sdk`, `@localbase/cli`) share a single version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/) with a beta prerelease line for the developer preview.

## [Unreleased]

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
