# LocalBase

Local-first backend platform. Define a schema, get a running API, query it with an SDK.

[![Phase 1-6 MVP](https://img.shields.io/badge/MVP-Complete-green)](LOCALBASE-MVP.md)
[![Phases 7–11](https://img.shields.io/badge/Post--MVP-Complete-green)](LOCALBASE-POST-MVP.md)
[![Status](https://img.shields.io/badge/status-developer%20preview-orange)](LAUNCH.md)

**Developer preview.** LocalBase is a single-process SQLite backend for local
development, prototypes, and small internal tools — not a multi-instance
production platform. See [Operational limits](#operational-limits-developer-preview).

Full documentation: **[docs/](docs/README.md)**.

---

## Quickstart

Requires **Node.js ≥ 22**.

```bash
# Scaffold a new project (package: @localbase/cli; binary name: localbase)
npx @localbase/cli init

# Start the dev server and open Admin Studio
npx @localbase/cli studio
```

REST API at `http://localhost:5180`, Admin Studio at
`http://localhost:5180/admin/`.

> **CLI package vs binary:** run `npx @localbase/cli …`. After installing
> `@localbase/cli` (global or as a project dependency), use `localbase`.
> There is no npm package named `localbase`.

Walkthrough: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

---

## What you get

- **SQLite** with auto-migrations from `localbase.config.ts`
- **REST API** generated from your tables
- **TypeScript SDK** — query builder, auth, realtime, Storage
- **Admin Studio** at `/admin/` — tables, schema, users, Storage, Jobs
- **Realtime** — `db.subscribe(...)` over WebSockets
- **Scheduled jobs** — cron TypeScript handlers with run history
- **Default-on auth** — JWT sessions, Argon2id passwords, refresh-token rotation
- **Owner policies (RLS)** — public API scoped to the signed-in user
- **Local file Storage** — private buckets and signed URLs
- **Hot-reload** when the config file changes

---

## Define your schema

Edit `localbase.config.ts`:

```ts
export default {
  auth: {
    enabled: true,
    jwtSecret: process.env.JWT_SECRET ?? "replace-with-a-long-random-secret",
  },
  tables: {
    users: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
      email: { type: "text", unique: true },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    posts: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      body: { type: "text" },
      user_id: { type: "integer", references: { table: "users", column: "id" } },
    },
  },
};
```

`localbase init` generates the fallback secret for you. Auth is enabled when
the section is omitted too, but then the server uses a new random secret on
each start; set `auth.enabled: false` to opt out explicitly. Save the file —
the dev server hot-reloads. Full config (auth, policies,
Storage, Jobs, CORS): [docs/CONFIG.md](docs/CONFIG.md).

![LocalBase Admin Studio](docs/admin-ui.png)

`localbase studio` opens Admin Studio at `/admin/`. [docs/ADMIN.md](docs/ADMIN.md).

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");
const { data, error } = await db.from("posts").select("*");
```

---

## Documentation

| Topic | Doc |
| --- | --- |
| Tutorial | [Getting started](docs/GETTING-STARTED.md) |
| Config and schema | [CONFIG](docs/CONFIG.md) |
| CLI | [CLI](docs/CLI.md) |
| REST | [REST](docs/REST.md) |
| SDK | [SDK](docs/SDK.md) |
| Auth and row-level security | [AUTH](docs/AUTH.md) |
| Realtime | [REALTIME](docs/REALTIME.md) |
| Storage | [STORAGE](docs/STORAGE.md) |
| Jobs | [JOBS](docs/JOBS.md) |
| Admin Studio | [ADMIN](docs/ADMIN.md) |
| Backup / restore | [BACKUP-AND-RECOVERY](docs/BACKUP-AND-RECOVERY.md) |
| Embed `@localbase/core` | [CORE](docs/CORE.md) |

Example app: [examples/task-board](examples/task-board/README.md).

---

## Operational limits (developer preview)

Honest expectations for the beta line. Procedures live in the linked docs.

| Topic | Preview behavior |
| --- | --- |
| **Support** | Prerelease (`0.1.0-beta.N`). APIs may still change. |
| **Database** | **SQLite only** (`better-sqlite3`). No PostgreSQL. |
| **Process** | One process for HTTP, WebSocket realtime, and Jobs. Do not run multiple `localbase dev` instances against the same data dir. |
| **Jobs** | No missed-run backfill, no automatic retries, no distributed lock. Overlapping runs of the same job are skipped. Handler edits need a process restart. |
| **Storage** | Files on **local disk** under `.localbase/storage/`. Not object storage or a CDN. Rotating the storage secret revokes outstanding signed URLs. |
| **Backups** | Manual `localbase db backup` / `db restore`. No automatic, remote, or encrypted backups. See [BACKUP-AND-RECOVERY](docs/BACKUP-AND-RECOVERY.md). |
| **Bind / exposure** | Default loopback. Non-loopback needs explicit `--host`, **TLS termination**, stable secrets, and configured **CORS** / rate limits. Auth-disabled admin is refused on non-loopback unless `--admin-unsafe-public`. |
| **Realtime + auth** | When auth is on, WebSocket clients authenticate and owner policies apply (including replay). System tables are not subscribable. |
| **Not a claim** | Not a multi-tenant production backend, not a Supabase replacement, not sized for large concurrent fleets. |

Launch stages: [LAUNCH.md](LAUNCH.md).

---

## Status of feature plans

MVP and post-MVP phases 7–11 **shipped** (auth, realtime, Storage, Admin Studio, Jobs). Root files named `LOCALBASE-*.md` are **historical plans** with completed checklists — prefer [docs/](docs/README.md) for current behavior.

Remaining launch work (private beta, go decision): [TASKS.md](TASKS.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs, feature requests, and beta feedback: [open an issue](https://github.com/reyanshdagoat9113/localbase/issues/new/choose). Security reports: [SECURITY.md](SECURITY.md).
Release process: [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

## License

[MIT](LICENSE) © 2026 Reyansh Dharmapurikar
