# Programmatic `@localbase/core`

Most apps should use the CLI. Use core when you embed LocalBase in your own Node process (tests, custom HTTP routes).

```bash
npm install @localbase/core
```

Node.js ≥ 22. Native addons (`better-sqlite3`, `@node-rs/argon2`) install from prebuilds on supported platforms.

```ts
import { Database, createServer } from "@localbase/core";
import { serve } from "@hono/node-server";

const schema = {
  notes: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    user_id: { type: "integer" as const, nullable: false },
    body: { type: "text" as const, nullable: false },
  },
};

const auth = { enabled: true as const, jwtSecret: process.env.JWT_SECRET ?? "dev-secret" };

const db = new Database({
  path: ".localbase/data.db",
  schema,
  auth,
  dataDir: ".localbase",
  buckets: [{ name: "avatars", public: true }],
});

const app = createServer(db, schema, {
  auth,
  admin: { enabled: true },
  policies: { notes: { ownerColumn: "user_id" } },
  security: { cors: { allowedOrigins: ["http://localhost:5173"] } },
});

serve({ fetch: app.fetch, port: 5180, hostname: "127.0.0.1" });
```

`createServer` returns a Hono app. You are responsible for bind address, TLS, realtime (`createRealtimeServer`), and the job `Scheduler` — the CLI wires those. If you only need CRUD + auth + admin HTTP, the snippet above is enough.

`Database` options: `path` (`":memory:"` allowed), `schema`, `auth`, `dataDir`, `buckets`, `jobs`, `autoMigrate` (default true).

Useful exports: `requireAuth`, `runMigrations`, `resetDatabase`, `createBackup`, `restoreBackup`, `BackupError`, job `Scheduler` / `JobRunner`, `createRealtimeServer`. Types re-exported from `@localbase/shared`.

Backup helpers: [BACKUP-AND-RECOVERY](./BACKUP-AND-RECOVERY.md#programmatic-use).
