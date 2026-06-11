# 🗄️ LocalBase

> Local-first backend platform. Define a schema, get a running API, query it with an SDK.

[![Phase 1-6 MVP](https://img.shields.io/badge/MVP-Complete-green)](LOCALBASE-MVP.md)
[![Phase 7 Auth](https://img.shields.io/badge/Phase%207-Auth-blue)](LOCALBASE-POST-MVP.md)

---

## Quickstart

```bash
# Scaffold a new project
npx @localbase/cli init

# Start the dev server
localbase dev
```

That's it. You now have a REST API running at `http://localhost:5180`.

---

## What you get

- **SQLite database** with auto-migrations
- **REST API** auto-generated from your schema
- **TypeScript SDK** with a Supabase-style query builder
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
localbase db migrate                    Run pending migrations + show status
localbase db reset                      Drop all tables, re-run migrations from scratch
localbase auth create-user              Create a user (requires auth.enabled in config)
localbase auth list-users               List all users
localbase auth reset-password           Reset a user's password
localbase --help                        Show all commands
```

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

MVP is complete. Phase 7 (Auth) is also done — see the Authentication
section above. See [`LOCALBASE-POST-MVP.md`](LOCALBASE-POST-MVP.md) for what's
next:

- **Phase 8:** Realtime (WebSockets + subscriptions)
- **Phase 9:** Scheduled Jobs (cron + handlers)
- **Phase 10:** Storage (file uploads + signed URLs)
- **Phase 11:** Admin UI

---

## License

MIT
