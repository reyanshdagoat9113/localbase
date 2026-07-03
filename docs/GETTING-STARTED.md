# Getting Started with LocalBase

> Define a schema, get a running API with auth. No database setup, no server config.

---

## The Big Picture

```
localbase.config.ts  →  localbase dev  →  REST API at localhost:5180
                              ↓
                    SQLite database (auto-created)
                    Auth system (optional, just flip a switch)
                    Hot-reload on schema changes
```

You write one config file. LocalBase handles everything else.

---

## Quick Start

### 1. Initialize

```bash
mkdir my-app && cd my-app
npx localbase init
```

This creates:

```
my-app/
  localbase.config.ts    ← your schema goes here
  .localbase/            ← SQLite database (gitignored)
```

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
npx localbase dev
```

```
✔ Server running at http://localhost:5180
ℹ Watching localbase.config.ts for changes...
```

That's it. You now have a REST API:

```
GET    /api/posts           → list all posts
GET    /api/posts/1         → get one post
POST   /api/posts           → create a post
PATCH  /api/posts/1         → update a post
DELETE /api/posts/1         → delete a post
```

Works the same for any table you define. No extra code needed.

### 4. Use the SDK from your frontend

```bash
npm install @localbase/sdk
```

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

// Fetch all posts
const { data, error } = await db.from("posts").select("*");

// With filters
const published = await db.from("posts")
  .select("*")
  .eq("published", true)
  .order("created_at", { ascending: false });

// Insert
await db.from("posts").insert({ title: "Hello", body: "World" });

// Update
await db.from("posts").update({ published: true }).eq("id", 1);

// Delete
await db.from("posts").delete().eq("id", 1);
```

---

## Adding Authentication

### Step 1 — Flip the switch

Add `auth` to your config:

```ts
export default {
  auth: {
    enabled: true,
    jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
    minPasswordLength: 6,
  },

  tables: { ... },
};
```

Restart `localbase dev`. Two hidden tables (`_users`, `_sessions`) are auto-created. These survive `db reset` — your user data is never wiped.

### Step 2 — New API endpoints appear

```
POST /api/auth/signup     → create account, get tokens
POST /api/auth/signin     → log in, get tokens
GET  /api/auth/user       → who am I?
POST /api/auth/signout    → invalidate session
POST /api/auth/refresh    → get new tokens
```

### Step 3 — Use the SDK

```ts
const db = createClient("http://localhost:5180");

// Sign up
const { data, error } = await db.auth.signUp({
  email: "rey@example.com",
  password: "supersecret",
});

// Sign in
await db.auth.signIn({ email: "rey@example.com", password: "supersecret" });

// Get current user
const { data } = await db.auth.getUser();

// Sign out
await db.auth.signOut();
```

### Step 4 — The magic: auto-attached tokens

After `signIn` or `signUp`, **every `db.from()` call automatically includes the Bearer token**. No manual headers.

```ts
await db.auth.signIn({ email, password });

// This just works — token is attached for you
const posts = await db.from("posts").select("*");
```

### Step 5 — Persist sessions across page reloads

The SDK doesn't touch `localStorage` automatically — you decide how to persist:

```ts
// On login:
db.auth.signIn({ email, password });
localStorage.setItem("session", JSON.stringify(db.auth.getSession()));

// On page load:
const saved = localStorage.getItem("session");
if (saved) db.auth.setSession(JSON.parse(saved));
```

### How it works under the hood

```
You sign up
  ↓
Server hashes password (Argon2id) → stores in _users
  ↓
Server creates JWT access token (1h) + refresh token (30 days)
  ↓
SDK stores both in a closure → db.from() reads from it on every request
  ↓
Every API call: "Authorization: Bearer <token>" → server verifies → responds
  ↓
Page reload → you restore session from localStorage → still logged in
```

---

## CLI Commands

```bash
npx localbase init                          # Create new project
npx localbase dev                           # Start server (port 5180)
npx localbase dev --port 4000               # Custom port
npx localbase db migrate                    # Run pending migrations
npx localbase db reset                      # Drop tables, start fresh

# Auth (requires auth.enabled in config)
npx localbase auth create-user -e user@test.com -p secret
npx localbase auth list-users
npx localbase auth reset-password -e user@test.com -p newpass
```

---

## Column Types

```ts
{
  id:    { type: "integer", primaryKey: true, autoIncrement: true },
  name:  { type: "text", nullable: false },
  price: { type: "real" },                // floating point
  done:  { type: "boolean", default: "0" },
  email: { type: "text", unique: true },
  bio:   { type: "text" },                // nullable by default
  fk:    { type: "integer", references: { table: "users", column: "id" } },
  time:  { type: "text", default: "CURRENT_TIMESTAMP" },
}
```

---

## SDK Query Builder

```ts
// Filtering
.eq("status", "active")              // equals
.neq("status", "archived")           // not equals
.gt("age", 18)                       // greater than
.lt("age", 65)                       // less than
.gte("age", 18)                      // greater than or equal
.lte("age", 65)                      // less than or equal
.like("name", "john")                // LIKE pattern
.in("status", ["active", "pending"]) // IN list

// Sorting
.order("created_at", { ascending: false })

// Pagination
.limit(10)
.offset(20)

// Single row (returns one object instead of array)
.eq("id", 1).single()
```

Filters chain naturally — they all AND together:

```ts
await db.from("tasks")
  .select("*")
  .eq("project_id", 1)
  .in("priority", ["high", "urgent"])
  .gte("due_date", today)
  .order("created_at", { ascending: false })
  .limit(20);
```

---

## Typical Project Structure

```
my-app/
  localbase.config.ts      ← schema + auth config
  .localbase/
    data.db                ← SQLite (gitignored)
  frontend/
    src/
      api.ts               ← createClient + session helpers
      App.tsx              ← your UI
    package.json           ← depends on @localbase/sdk
```

Two terminals:

```bash
# Terminal 1 — backend
npx localbase dev

# Terminal 2 — frontend
cd frontend && npm run dev
```

---

## Production Notes

- **Set a real `jwtSecret`** — use `process.env.JWT_SECRET`. If you don't, a random one is generated each restart and everyone gets signed out.
- **Access tokens expire in 1h** (default) — call `db.auth.refresh()` to get new ones.
- **`.localbase/` is gitignored** — database stays local, not in version control.
- **Single process** — LocalBase runs one Node process. Good for thousands of concurrent users. If you need more later, add a reverse proxy.
