# Getting started

Define a schema, get a REST API plus optional auth, Storage, realtime, Jobs, and Admin Studio. No Docker, no cloud account.

**Developer preview.** Single-process SQLite for local development, prototypes, and small internal tools. Read [operational limits](../README.md#operational-limits-developer-preview) before binding beyond loopback.

Requires **Node.js ≥ 22**.

```
localbase.config.ts  →  localbase studio  →  REST at http://localhost:5180
                              ↓
                    SQLite in .localbase/data.db
                    Admin Studio at /admin/
                    Hot-reload on config save
```

---

## 1. Initialize

```bash
mkdir my-app && cd my-app
npx @localbase/cli init
```

`init` scaffolds the **current directory only** (no `init <path>`). It creates:

```
my-app/
  localbase.config.ts    schema
  .localbase/            SQLite + uploaded files (gitignored if a .gitignore already exists)
```

The npm package is `@localbase/cli`; the binary is `localbase`. After `npm install -g @localbase/cli` (or a local dependency), use `localbase …`. There is no package named `localbase`.

## 2. Define tables

```ts
export default {
  tables: {
    posts: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      body: { type: "text" },
      published: { type: "boolean", default: "0" },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    comments: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      post_id: { type: "integer", references: { table: "posts", column: "id" } },
      author: { type: "text", nullable: false },
      body: { type: "text", nullable: false },
    },
  },
};
```

Column types, migrations, and the rest of the config: [CONFIG](./CONFIG.md).

## 3. Start the server

```bash
npx @localbase/cli studio
# or: npx @localbase/cli dev
```

```
✔ Server running at http://localhost:5180
ℹ Watching localbase.config.ts for changes...
```

You now have CRUD at `/api/:table` and Studio at `http://localhost:5180/admin/`.

```
GET    /api/posts
GET    /api/posts/1
POST   /api/posts
PATCH  /api/posts/1
DELETE /api/posts/1
```

CLI flags (`--port`, `--host`): [CLI](./CLI.md). REST details: [REST](./REST.md).

## 4. Query from a frontend

```bash
npm install @localbase/sdk
```

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

const { data, error } = await db.from("posts").select("*");

await db.from("posts").insert({ title: "Hello", body: "World" });
await db.from("posts").update({ published: true }).eq("id", 1);
await db.from("posts").delete().eq("id", 1);
```

Every SDK method returns `{ data, error }` — it does not throw on HTTP errors. Query builder: [SDK](./SDK.md).

---

## Enable auth (optional)

```ts
export default {
  auth: {
    enabled: true,
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  },
  tables: { /* ... */ },
};
```

Restart the server. System tables `_users`, `_sessions`, and `_admin_requests` are created automatically and survive `db reset`.

```ts
await db.auth.signUp({ email: "you@example.com", password: "supersecret" });
await db.auth.signIn({ email: "you@example.com", password: "supersecret" });
```

After sign-in, `db.from(...)` attaches the Bearer token. The SDK does **not** persist sessions — store `db.auth.getSession()` yourself (see [AUTH](./AUTH.md)).

Open Studio and create the first account: it becomes the **owner**. Later sign-ups are ordinary users until an admin promotes them.

---

## Typical layout

```
my-app/
  localbase.config.ts
  .localbase/
    data.db
    storage/          uploaded files
  jobs/               optional job handlers
  frontend/
    src/
    package.json      depends on @localbase/sdk
```

Two terminals: `npx @localbase/cli studio` in the project root, `npm run dev` in `frontend/`.

---

## Next

| I want to… | Read |
| --- | --- |
| Declare policies, buckets, Jobs, CORS | [CONFIG](./CONFIG.md) |
| Filter, paginate, handle status codes | [REST](./REST.md) / [SDK](./SDK.md) |
| Scope rows to the signed-in user | [AUTH](./AUTH.md) |
| Subscribe to inserts/updates | [REALTIME](./REALTIME.md) |
| Upload files | [STORAGE](./STORAGE.md) |
| Run cron work | [JOBS](./JOBS.md) |
| Back up the database | [BACKUP-AND-RECOVERY](./BACKUP-AND-RECOVERY.md) |
| See a full app | [Task board example](../examples/task-board/README.md) |
