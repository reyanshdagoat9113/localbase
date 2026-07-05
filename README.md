# 🗄️ LocalBase

> Local-first backend platform. Define a schema, get a running API, query it with an SDK.

[![Phase 1-6 MVP](https://img.shields.io/badge/MVP-Complete-green)](LOCALBASE-MVP.md)
[![Phase 7 Auth](https://img.shields.io/badge/Phase%207-Auth-blue)](LOCALBASE-POST-MVP.md)

---

## Quickstart

```bash
# Scaffold a new project
npx @localbase/cli init

# Start the dev server (and open the admin UI in your browser)
localbase studio
```

That's it. You now have a REST API running at `http://localhost:5180`
and a built-in admin dashboard at `http://localhost:5180/admin/`
where you can browse and edit your data without writing code.

---

## What you get

- **SQLite database** with auto-migrations
- **REST API** auto-generated from your schema
- **TypeScript SDK** with a Supabase-style query builder
- **Built-in admin UI** at `/admin/` — browse tables, edit rows, manage users
- **Realtime subscriptions** — `db.from('x').subscribe(...)` over WebSockets
- **Optional auth** — JWT sessions, Argon2id passwords, refresh-token rotation
- **Hot-reload** on schema changes
- **Zero config** — define tables, everything else is automatic

---

## Define your schema

Edit `localbase.config.ts`:

```ts
export default {
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

Save the file — the dev server hot-reloads automatically.

---

## CLI commands

```
localbase init                          Scaffold a new project (creates .localbase/ + config file)
localbase dev                           Start dev server (port 5180, hot-reload on schema change)
localbase dev --port 4000               Start on a custom port
localbase dev --open                    Start the dev server and open the admin UI
localbase studio                        Alias for `localbase dev --open` (opens the admin UI)
localbase db migrate                    Run pending migrations + show status
localbase db reset                      Drop all tables, re-run migrations from scratch
localbase auth create-user              Create a user (requires auth.enabled in config)
localbase auth list-users               List all users
localbase auth reset-password           Reset a user's password
localbase admin promote <email>         Grant admin rights to a user
localbase admin demote <email>          Revoke admin rights from a user
localbase --help                        Show all commands
```

---

## 🎨 Admin UI (LocalBase Studio)

LocalBase ships a built-in admin dashboard at `http://localhost:5180/admin/`
that lets you browse tables, edit rows inline, inspect your schema, and
manage users — without writing a line of code. It's served by core itself,
so `localbase dev` (or `localbase studio`) is all you need.

```bash
# Start the server AND open the dashboard in your default browser.
localbase studio

# Or: start the server manually and open the URL yourself.
localbase dev
# → http://localhost:5180/admin/
```

**What you get on first run:**

- **Table browser** — sidebar lists every table (including system tables)
  with live row counts; click to see rows in a sortable, filterable grid.
- **Inline row editor** — double-click any cell, edit, hit Enter; the
  change propagates to every realtime subscriber.
- **Add / delete rows** — no SQL required.
- **Schema viewer** — see columns, types, primary keys, foreign keys,
  and indexes for every table.
- **Auth Manager** — list users, create users, reset passwords, promote
  or demote admins (only available when `auth.enabled` is on). The owner
  cannot be demoted, and other admins cannot reset the owner's password.
- **First-user bootstrap** — the first account to sign up is
  automatically the owner; everyone else starts as `user` and needs a
  promote from an existing admin (or via `localbase admin promote`).

**Behind the scenes:** the admin UI is a React + Vite SPA built into
`@localbase/core` at publish time. All edits go through the same
`Database` class your SDK calls, so any change you make in the dashboard
fires a realtime event that subscribed clients see instantly. See
[`LOCALBASE-ADMIN-UI.md`](LOCALBASE-ADMIN-UI.md) for the full design.

**Safety:** when auth is enabled, every admin route is gated by a JWT
admin or owner role that is *re-read from the database on every request* — so
demoting a user takes effect on their very next admin call, even with
a still-valid access token. When auth is *disabled*, the admin API is
ungated and LocalBase refuses to bind it to a non-loopback interface
unless you pass `--admin-unsafe-public`.

---

## REST API

Auto-generated CRUD per table:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/:table` | List rows (filter, sort, paginate) |
| `POST` | `/api/:table` | Insert a row |
| `GET` | `/api/:table/:id` | Get a single row |
| `PATCH` | `/api/:table/:id` | Update a row |
| `DELETE` | `/api/:table/:id` | Delete a row |

### Query parameters

```
GET /api/users?age=gte.25&order=created_at.desc&limit=10
```

| Param | Format | Example |
|---|---|---|
| Filter | `?col=op.value` | `?age=gte.25` |
| Sort | `?order=col.dir` | `?order=created_at.desc` |
| Limit | `?limit=N` | `?limit=10` |
| Offset | `?offset=N` | `?offset=20` |

**Filter operators:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `in`

**IN example:** `?name=in.Alice,Bob,Charlie`

---

## SDK

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

// SELECT
const users = await db.from("users").select("*");
const alice = await db.from("users").select("*").eq("name", "Alice").single();

// INSERT
await db.from("users").insert({ name: "Reyansh", email: "r@r.com" });

// UPDATE (by id)
await db.from("users").update({ name: "New Name" }).eq("id", 1);

// DELETE (by id)
await db.from("users").delete().eq("id", 1);

// FILTERS
await db.from("users")
  .select("*")
  .eq("age", 30)
  .gte("age", 25)
  .lt("age", 60)
  .like("name", "%rey%")
  .in("name", ["Alice", "Bob"]);

// SORT + PAGINATE
await db.from("users")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(10)
  .offset(20);
```

All SDK methods return `{ data, error }`:

```ts
const { data, error } = await db.from("users").select("*");
if (error) console.error(error);
else console.log(data);
```

---

## Authentication

LocalBase ships with a built-in auth subsystem: user accounts, Argon2id-hashed
passwords, short-lived JWT access tokens, and long-lived rotating refresh
tokens. Enable it by adding `auth` to your config:

```ts
// localbase.config.ts
export default {
  tables: { ... },

  auth: {
    enabled: true,
    // In production, set this to a stable, secret value. If you omit it,
    // LocalBase generates a random one at startup and logs a warning —
    // every restart will sign everyone out.
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",

    // Optional, with sensible defaults:
    accessTokenExpiry: "1h",      // jose shorthand: "30s", "15m", "7d"
    refreshTokenExpiry: 60 * 60 * 24 * 30,  // 30 days, in seconds
    minPasswordLength: 8,
  },
};
```

Restart `localbase dev` and two system tables — `_users` and `_sessions` —
will be auto-provisioned alongside your own.

### SDK auth

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

// Sign up — returns the full session and stores it in the client.
const { data, error } = await db.auth.signUp({
  email: "rey@example.com",
  password: "supersecret",
});
if (error) throw error;
console.log("Logged in as", data.user.email);

// Sign in to an existing account.
await db.auth.signIn({
  email: "rey@example.com",
  password: "supersecret",
});

// Fetch the current user.
const { data: me } = await db.auth.getUser();
console.log("Hi,", me?.user.email);

// Refresh an expired access token (rotates both access + refresh).
await db.auth.refresh();

// Sign out (clears the local session and invalidates the server one).
await db.auth.signOut();
```

After `signIn` or `signUp`, **every query on `db.from(...)` automatically
attaches the Bearer token** to the request. There is no manual header
plumbing.

To persist the session across page reloads:

```ts
// On login:
db.auth.signIn({ email, password }).then(() => {
  localStorage.setItem("session", JSON.stringify(db.auth.getSession()));
});

// On page load:
const saved = localStorage.getItem("session");
if (saved) db.auth.setSession(JSON.parse(saved));
```

### REST endpoints

```
POST /api/auth/signup        Create account, returns { user, accessToken, refreshToken, expiresAt }
POST /api/auth/signin        Start session
POST /api/auth/signout       Invalidate the refresh token (requires Authorization: Bearer)
GET  /api/auth/user          Return the current user (requires Authorization: Bearer)
POST /api/auth/refresh       Rotate access + refresh tokens
```

All endpoints return JSON in the same envelope as the table API:

```json
{ "data": { ... }, "error": null }
```

### Protecting your own routes

The `requireAuth` middleware is exported from `@localbase/core`. Use it in
your own server to protect any route:

```ts
import { createServer, requireAuth } from "@localbase/core";

const app = createServer(db, schema, { auth: { enabled: true, jwtSecret: "..." } });

// Protect a single route:
app.get("/api/me/orders", requireAuth(secret), (c) => {
  const user = c.get("user"); // { id, email }
  // ...
});

// Or a prefix:
app.use("/api/admin/*", requireAuth(secret));
```

### CLI

```bash
# Bootstrap a user without going through the API.
localbase auth create-user --email alice@example.com --password supersecret

# List all users (oldest first).
localbase auth list-users

# Reset a user's password.
localbase auth reset-password --email alice@example.com --password newsecret
```

You can also pass credentials via env vars to keep them out of your shell
history:

```bash
AUTH_EMAIL=alice@example.com AUTH_PASSWORD=supersecret \
  localbase auth create-user
```

### How it works

- **Password storage** — Argon2id with a random per-user salt. Passwords
  are never stored in plaintext and never leave the server.
- **Access tokens** — JWT signed with HS256, default 1-hour lifetime.
  Stateless: the server verifies them by signature alone, no DB lookup
  per request.
- **Refresh tokens** — 256 bits of random hex (64 chars), stored in
  `_sessions`. Long-lived (30 days by default). Rotated on every refresh
  — the old token is invalidated as soon as a new one is issued, so a
  stolen token has a tiny attack window.
- **System tables** — `_users` and `_sessions` are filtered out of
  `db reset`, so resetting your app's data never wipes the auth subsystem.

---

## Storage

LocalBase ships with a bucket-based file API at `/api/storage/:bucket` for
upload / download / list / delete, backed by the local filesystem under your
`.localbase/` data directory. Files are stored under a server-generated UUID
name (the original name is kept as metadata and restored on download via
`Content-Disposition`), so user-supplied filenames can never be used for path
traversal or to overwrite another object.

Buckets are **private by default**. Reads of a private file require auth **or**
a valid signed URL; writes always require auth, even on public buckets.
If auth is disabled, writes/listing and private reads fail closed; public bucket
reads still work.

```ts
// localbase.config.ts
export default {
  tables: { ... },

  auth: { enabled: true, jwtSecret: process.env.JWT_SECRET },

  // Optional: pre-declare buckets and their visibility. Any bucket not
  // listed here is created automatically on first upload as private.
  buckets: [
    { name: "avatars", public: true },
    { name: "documents" },          // private (default)
  ],

  // Optional: a dedicated secret for signing storage URLs. Falls back to
  // auth.jwtSecret when omitted.
  storage: {
    secret: process.env.STORAGE_SECRET,
    maxFileSize: 50 * 1024 * 1024,  // 50 MiB, the default
  },
};
```

### SDK

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");
await db.auth.signIn({ email, password });

const storage = db.storage;

// Upload — returns metadata (originalName, storedName, size, mime).
const { data, error } = await storage.from("avatars").upload(file);

// Files are addressed by their ORIGINAL name for ergonomics.
await storage.from("avatars").list();
const { data: blob } = await storage.from("avatars").download("reyansh.jpg");
await storage.from("avatars").remove("reyansh.jpg");

// Public buckets: a plain, token-less URL.
const { data: url } = await storage.from("avatars").getPublicUrl("reyansh.jpg", { absolute: true });

// Private buckets: mint a short-lived signed URL an unauthenticated client
// (e.g. an <img>) can use. The signing secret never leaves the server.
const { data: signed } = await storage
  .from("documents")
  .createSignedUrl("report.pdf", { expiresIn: 3600 });
```

### REST endpoints

```
POST   /api/storage/:bucket                      Upload (multipart, auth)
GET    /api/storage/:bucket/:filename            Download (public bucket → open;
                                                 private → auth or signed URL)
DELETE /api/storage/:bucket/:filename            Delete (auth)
GET    /api/storage/:bucket                      List files (auth)
POST   /api/storage/:bucket/:filename/sign       Create a signed URL (auth)
```

Signed URLs carry `?expires=<unix>&sig=<hmac>`; verify is constant-time and
expiry-checked. Rotating the storage secret revokes all outstanding signed
URLs. The Admin UI (LocalBase Studio) includes a Storage browser for listing
and deleting files.

---

## Column types

| Type | SQLite mapping | Notes |
|---|---|---|
| `integer` | `INTEGER` | Whole numbers |
| `text` | `TEXT` | Strings |
| `real` | `REAL` | Floating-point |
| `boolean` | `INTEGER` | Stored as 0/1 |
| `blob` | `BLOB` | Binary data |

### Column options

```ts
{
  type: "text",
  primaryKey: true,      // PK constraint
  autoIncrement: true,   // AUTOINCREMENT (use with PK + integer)
  nullable: false,       // NOT NULL (default: nullable)
  unique: true,          // UNIQUE constraint
  default: "CURRENT_TIMESTAMP",  // DEFAULT value (SQL expression)
  references: { table: "users", column: "id" },  // FK
}
```

---

## Project structure (after `init`)

```
your-project/
├── .localbase/
│   └── data.db          SQLite database (auto-created)
└── localbase.config.ts  Schema definition
```

---

## HTTP status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created (insert) |
| `400` | Bad request (validation error) |
| `404` | Not found (unknown table / row missing) |
| `409` | Conflict (UNIQUE constraint violation) |
| `500` | Internal server error |

---

## Roadmap

MVP is complete. Phase 7 (Auth) and Phase 9 (Storage) are also done — see the
relevant sections above. See [`LOCALBASE-POST-MVP.md`](LOCALBASE-POST-MVP.md)
for what's next:

- **Phase 8:** Realtime (WebSockets + subscriptions)
- **Phase 9:** Scheduled Jobs (cron + handlers)
- **Phase 10:** Storage (file uploads + signed URLs)
- **Phase 11:** Admin UI

---

## License

MIT
