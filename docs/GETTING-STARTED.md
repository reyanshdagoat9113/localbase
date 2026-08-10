# Getting Started with LocalBase

> Define a schema, get a running API with optional auth, Storage, realtime, Jobs,
> and Admin Studio. No Docker, no cloud account.

**Developer preview.** LocalBase is a **single-process SQLite** backend for local
development, prototypes, and small internal tools. See
[Operational limits](#operational-limits) before using it beyond loopback.

Requires **Node.js ≥ 22**.

---

## The big picture

```
localbase.config.ts  →  localbase dev / studio  →  REST API at localhost:5180
                              ↓
                    SQLite database (auto-created)
                    Optional auth, Storage, Jobs, realtime
                    Admin Studio at /admin/
                    Hot-reload on schema changes
```

You write one config file. LocalBase handles the rest.

---

## Quick start

### 1. Initialize

```bash
mkdir my-app && cd my-app
npx @localbase/cli init
```

`init` scaffolds the **current working directory only** (no `init <path>` form).
It creates:

```
my-app/
  localbase.config.ts    ← your schema goes here
  .localbase/            ← SQLite database (gitignored)
```

> **Package vs binary:** the npm package is `@localbase/cli`; the binary name is
> `localbase`. Prefer `npx @localbase/cli …` for a clean machine. After
> `npm install -g @localbase/cli` (or installing it as a project dependency),
> use `localbase …` / `npx localbase …`. There is no separate package named
> `localbase` on npm.

### 2. Define your tables

Edit `localbase.config.ts`:

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

### 3. Start the server

```bash
npx @localbase/cli studio
# or: npx @localbase/cli dev
```

```
✔ Server running at http://localhost:5180
ℹ Watching localbase.config.ts for changes...
```

You now have:

- REST CRUD at `/api/:table`
- Admin Studio at `http://localhost:5180/admin/`

```
GET    /api/posts           → list all posts
GET    /api/posts/1         → get one post
POST   /api/posts           → create a post
PATCH  /api/posts/1         → update a post
DELETE /api/posts/1         → delete a post
```

### 4. Use the SDK from your frontend

```bash
npm install @localbase/sdk
```

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

const { data, error } = await db.from("posts").select("*");

const published = await db.from("posts")
  .select("*")
  .eq("published", true)
  .order("created_at", { ascending: false });

await db.from("posts").insert({ title: "Hello", body: "World" });
await db.from("posts").update({ published: true }).eq("id", 1);
await db.from("posts").delete().eq("id", 1);
```

---

## Adding authentication

### Step 1 — Enable auth in config

```ts
export default {
  auth: {
    enabled: true,
    // Use a stable secret outside pure local throwaway use.
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
    minPasswordLength: 8,
  },

  tables: { /* ... */ },
};
```

Restart `localbase dev` / `studio`. System tables `_users`, `_sessions`, and
`_admin_requests` are auto-created. They survive `db reset` so user accounts are
not wiped with app data.

### Step 2 — Auth endpoints

```
POST /api/auth/signup     → create account, get tokens
POST /api/auth/signin     → log in, get tokens
GET  /api/auth/user       → who am I?
POST /api/auth/signout    → invalidate session
POST /api/auth/refresh    → rotate tokens
```

### Step 3 — SDK

```ts
const db = createClient("http://localhost:5180");

await db.auth.signUp({ email: "rey@example.com", password: "supersecret" });
await db.auth.signIn({ email: "rey@example.com", password: "supersecret" });
const { data } = await db.auth.getUser();
await db.auth.signOut();
```

After `signIn` or `signUp`, **every `db.from()` call attaches the Bearer token**.

### Step 4 — Persist sessions across reloads

The SDK does not write `localStorage` for you:

```ts
// On login:
await db.auth.signIn({ email, password });
localStorage.setItem("session", JSON.stringify(db.auth.getSession()));

// On page load:
const saved = localStorage.getItem("session");
if (saved) db.auth.setSession(JSON.parse(saved));
```

### Admin Studio and the first owner

- Open `http://localhost:5180/admin/` and create the first account — it becomes
  the **owner**.
- Later accounts are normal users; promote via Admin Studio or
  `localbase admin promote <email>`.
- After an owner exists, the signed-out Studio accepts **admin-account
  requests** (owner approves/rejects).

---

## Storage, realtime, and Jobs (optional)

These are implemented and documented in the root [README](../README.md):

| Feature | How to use |
|---|---|
| **Storage** | `buckets` / `storage` in config; `db.storage.from("avatars").upload(file)` |
| **Realtime** | `db.from("posts").subscribe(...)` (WebSockets; auth/RLS when auth is on) |
| **Jobs** | `jobs` map in config + handler files; `localbase jobs list\|run\|logs` |
| **Backups** | `localbase db backup` / `localbase db restore <dir>` — see [BACKUP-AND-RECOVERY.md](./BACKUP-AND-RECOVERY.md) |

---

## CLI commands

```bash
npx @localbase/cli init
npx @localbase/cli dev
npx @localbase/cli studio
npx @localbase/cli dev --port 4000
npx @localbase/cli db migrate
npx @localbase/cli db reset
npx @localbase/cli db backup
npx @localbase/cli db restore backups/<dir>

# Auth (requires auth.enabled)
npx @localbase/cli auth create-user -e user@test.com -p secret
npx @localbase/cli auth list-users
npx @localbase/cli auth reset-password -e user@test.com -p newpass

# Roles
npx @localbase/cli admin promote user@test.com
npx @localbase/cli admin demote user@test.com

# Jobs (requires jobs in config)
npx @localbase/cli jobs list
npx @localbase/cli jobs run <name>
npx @localbase/cli jobs logs <name>
```

---

## Column types

```ts
{
  id:    { type: "integer", primaryKey: true, autoIncrement: true },
  name:  { type: "text", nullable: false },
  price: { type: "real" },
  done:  { type: "boolean", default: "0" },
  email: { type: "text", unique: true },
  bio:   { type: "text" },
  fk:    { type: "integer", references: { table: "users", column: "id" } },
  time:  { type: "text", default: "CURRENT_TIMESTAMP" },
}
```

---

## SDK query builder

```ts
.eq("status", "active")
.neq("status", "archived")
.gt("age", 18)
.lt("age", 65)
.gte("age", 18)
.lte("age", 65)
.like("name", "john")
.in("status", ["active", "pending"])
.order("created_at", { ascending: false })
.limit(10)
.offset(20)
.eq("id", 1).single()
```

Filters AND together:

```ts
await db.from("tasks")
  .select("*")
  .eq("project_id", 1)
  .in("priority", ["high", "urgent"])
  .order("created_at", { ascending: false })
  .limit(20);
```

---

## Typical project structure

```
my-app/
  localbase.config.ts
  .localbase/
    data.db
    storage/               ← uploaded files (if Storage is used)
  jobs/                    ← optional job handlers
  frontend/
    src/
      api.ts
      App.tsx
    package.json           ← depends on @localbase/sdk
```

Two terminals:

```bash
# Terminal 1 — backend
npx @localbase/cli studio

# Terminal 2 — frontend
cd frontend && npm run dev
```

---

## Operational limits

Honest limits for the developer-preview / beta line:

| Topic | Behavior |
|---|---|
| **Database** | SQLite only. No PostgreSQL in this release. |
| **Process model** | One Node process for HTTP, realtime WebSockets, and the job scheduler. Do not run multiple servers against the same `.localbase/` directory. |
| **Jobs** | No missed-run backfill, no automatic retries, no multi-instance lock. Overlapping runs of the same job are skipped. Restart after editing handler files. |
| **Storage** | Local disk under `.localbase/storage/`. Not a CDN or multi-region object store. |
| **Backups** | Manual `db backup` / `db restore` with checksum verification. No automatic remote or encrypted backups. |
| **Secrets** | Set a stable `auth.jwtSecret` (and optional `storage.secret`). A random secret each restart invalidates sessions/signed URLs. |
| **Non-loopback** | Use TLS termination, configure CORS and rate limits, keep strong secrets. Auth-disabled admin refuses non-loopback binds unless `--admin-unsafe-public`. |
| **Positioning** | Not a multi-tenant production platform or “Supabase replacement.” Good for local dev, prototypes, and small internal tools. |

Full product surface and security notes: [root README](../README.md). Backup procedure: [BACKUP-AND-RECOVERY.md](./BACKUP-AND-RECOVERY.md). Launch stages: [LAUNCH.md](../LAUNCH.md).
