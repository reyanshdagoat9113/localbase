# LocalBase documentation

LocalBase is a **single-process SQLite backend** for local development, prototypes, and small internal tools. You declare tables in `localbase.config.ts`; the CLI starts a REST API, optional auth, Storage, realtime, Jobs, and Admin Studio.

**Developer preview** (`0.1.0-beta.x`). APIs can still change. It is not a multi-instance production platform. Read [Operational limits](../README.md#operational-limits-developer-preview) before exposing it beyond loopback.

Requires **Node.js ≥ 22**. npm package `@localbase/cli`, binary name `localbase`.

## Start here

| Doc | What it covers |
| --- | --- |
| [Getting started](./GETTING-STARTED.md) | Init, schema, `studio`, first SDK queries |
| [Config](./CONFIG.md) | `localbase.config.ts`: tables, auth, policies, Storage, Jobs, realtime, security |
| [CLI](./CLI.md) | Every command, flag, and env var |

## Product surface

| Doc | What it covers |
| --- | --- |
| [REST API](./REST.md) | Generated CRUD, filters, status codes |
| [SDK](./SDK.md) | `createClient`, query builder, `{ data, error }` |
| [Auth & RLS](./AUTH.md) | Accounts, JWTs, roles, owner policies |
| [Realtime](./REALTIME.md) | WebSocket subscriptions, presence, replay |
| [Storage](./STORAGE.md) | Buckets, uploads, signed URLs |
| [Jobs](./JOBS.md) | Cron handlers and run history |
| [Admin Studio](./ADMIN.md) | Dashboard at `/admin/` |
| [Backup and recovery](./BACKUP-AND-RECOVERY.md) | Online backup, verify-then-swap restore |

## Embedding and examples

| Doc | What it covers |
| --- | --- |
| [Programmatic core](./CORE.md) | `Database` + `createServer` without the CLI |
| [Task board example](../examples/task-board/README.md) | Auth, FKs, junction tables, client-side joins |

## Operators and contributors

| Doc | What it covers |
| --- | --- |
| [Security reporting](../SECURITY.md) | Private vulnerability reports |
| [Contributing](../CONTRIBUTING.md) | Monorepo setup, tests, PR expectations |
| [Release checklist](./RELEASE-CHECKLIST.md) | Beta publish steps |

Historical architecture and phase plans live at the repo root (`LOCALBASE.md`, `LOCALBASE-MVP.md`, `LOCALBASE-POST-MVP.md`, and related files). Prefer this folder and the root [README](../README.md) for current behavior.
