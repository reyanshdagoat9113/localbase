# 🚀 LocalBase Post-MVP

> What we build after the MVP ships. Focused on what makes the platform feel modern.

---

## Priority Order

1. ~~**Auth**~~ — ✅ **Done** (Phase 7)
2. ~~**Realtime**~~ — ✅ **Done** (Phase 8) — biggest perceived value, hardest to do well
3. **Storage** ➡️ dedicated plan — needs auth for private buckets (auth now exists)
4. ~~**Admin UI**~~ — ✅ **Done** (Phase 10) — differentiator vs dev-only tools
5. **Scheduled Jobs** — genuinely useful, simpler scope

Edge Functions are **out of scope**. Developers can just write Node scripts.

PostgreSQL support is **out of scope** for post-MVP. See CLI note below.

---

### Phase 7: Auth ✅ DONE

**Goal:** Secure the platform with user authentication and authorization.

**SDK example:**

```ts
const db = createClient("http://localhost:5180");

await db.auth.signUp({ email: "rey@example.com", password: "secret" });
await db.auth.signIn({ email: "rey@example.com", password: "secret" });
const user = await db.auth.getUser();
await db.auth.signOut();
```

**REST API:**

```
POST /api/auth/signup      → create account
POST /api/auth/signin      → start session (returns JWT)
POST /api/auth/signout     → invalidate session
GET  /api/auth/user        → get current user
POST /api/auth/refresh     → refresh access token
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Auth router | `packages/core` | Hono routes for signup/signin/signout/user |
| Password hashing | `packages/core` | Argon2id via `argon2` package |
| JWT engine | `packages/core` | Issue access + refresh tokens |
| User table | SQLite | `_users` table (id, email, password_hash, created_at) |
| Sessions table | SQLite | `_sessions` table (id, user_id, token, expires_at) |
| Auth middleware | `packages/core` | Verify JWT on protected routes, attach `user` to context |
| SDK auth namespace | `packages/sdk` | `db.auth.signUp/signIn/getUser/signOut` |
| Row-level security | `packages/core` | Optional: ` policies` in config to restrict table access per user role |

**Tasks:**

- [x] Define `AuthConfig` type in `shared` (enable/disable auth, token expiry, etc.)
- [x] Create `_users` table with email unique constraint
- [x] Create `_sessions` table for refresh tokens
- [x] Add `argon2` dependency to `core` for password hashing (`@node-rs/argon2` — precompiled N-API equivalent)
- [x] Add `jose` or `jsonwebtoken` dependency for JWT handling
- [x] Implement `POST /api/auth/signup` (validate email, hash password, create user)
- [x] Implement `POST /api/auth/signin` (verify password, issue JWT + refresh token)
- [x] Implement `GET /api/auth/user` (validate JWT, return user payload)
- [x] Implement `POST /api/auth/signout` (invalidate refresh token)
- [x] Implement `POST /api/auth/refresh` (rotate refresh token, issue new JWT)
- [x] Add auth middleware to core API (attach `user` to Hono context)
- [x] Add `db.auth` namespace to SDK
- [x] Add `localbase auth` CLI commands: `create-user`, `list-users`, `reset-password`
- [x] Write integration tests: signup flow, signin flow, protected route, token expiry
- [x] Update README with auth quickstart

---

### Phase 8: Realtime ✅ DONE

**Goal:** Frontend gets notified instantly when data changes — no polling.

**SDK example:**

```ts
db.subscribe("messages", (event) => {
  console.log(event);
  // { type: "insert", table: "messages", row: { id: 5, text: "Hi" } }
});

db.subscribe("messages", { where: { room_id: 1 } }, (event) => {
  // Only fires for messages in this room
});
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Event emitter | `packages/core` | Hooks into insert/update/delete, emits events |
| Subscription manager | `packages/core` | Tracks who's subscribed to what |
| WebSocket server | `packages/core` | Handles WS connections, broadcasts events |
| SDK subscribe | `packages/sdk` | Opens WS, parses events |
| CLI | `packages/cli` | No changes — WS runs inside `dev` |

**Tasks:**

- [x] Add `EventEmitter` to `Database` class
- [x] Emit `insert`/`update`/`delete` events from `Database` (include row data)
- [x] Create `SubscriptionManager` — tracks subscriptions by table + filter
- [x] Set up WebSocket server alongside Hono (use `ws`)
- [x] Implement subscription message protocol: `{ type: "subscribe", table: "messages", filters: [...] }`
- [x] Send events to subscribed clients with row payload
- [x] Handle reconnect (exponential back-off; resends subscriptions)
- [x] Handle missed events (event log buffer)
- [x] Add `db.subscribe(table, filter?, callback)` to SDK
- [x] Add subscription filters (where, equals, gt, etc.)
- [x] Add presence support
- [x] Write integration tests: emit on insert, verify WS receives

---

### Phase 10: Admin UI ✅ DONE  ➡️  [Dedicated plan](./LOCALBASE-ADMIN-UI.md)

> **Promoted to its own plan — now complete.** The Admin UI is the one feature where LocalBase was uniquely absent vs. every competitor (see `COMPETITION.md`), and the single biggest perception/adoption lever. Full design, decision record, and milestone breakdown live in [`LOCALBASE-ADMIN-UI.md`](./LOCALBASE-ADMIN-UI.md). The summary below is kept for context.

**Goal:** A built-in management dashboard for inspecting and editing data without writing code.

**Why this matters:**
Every competitor (PocketBase, TrailBase, Supabase, Directus, NocoDB) has an admin UI. It is the first thing non-technical teammates or solo developers use to verify data, debug issues, and make quick edits. Without it, LocalBase feels like a "dev tool" instead of a "platform."

**URL:**
```
http://localhost:5180/_/admin
```

**Features:**

| Feature | Priority | Description |
|---|---|---|
| **Table browser** | P0 | List all tables, paginate rows, sort, search |
| **Row editor** | P0 | Inline edit cells, add new rows, delete rows |
| **Schema viewer** | P0 | Read-only view of current table schema (columns, types, constraints) |
| **Auth manager** | P1 | List users, reset passwords, assign roles (requires Phase 7: Auth) |
| **Storage browser** | P1 | View uploaded files, preview images, delete files (requires Phase 9: Storage) |
| **Realtime inspector** | P2 | Live log of WebSocket events, active subscriber count (requires Phase 8: Realtime) |
| **Job logs viewer** | P2 | View `_job_runs` history, status, output (requires Phase 11: Scheduled Jobs) |
| **API playground** | P2 | Auto-generated docs for all tables, test endpoints inline |

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Admin UI bundle | `packages/core` | A small React app served from a static Hono route (`/_admin/*`) |
| Admin API | `packages/core` | Protected endpoints: `GET /_api/admin/tables`, `GET /_api/admin/:table/rows`, `POST /_api/admin/:table/rows`, etc. |
| Auth gate | `packages/core` | Redirect to login if auth is enabled and no valid session (requires Phase 7) |
| React app | `packages/core` | Build with Vite or Rolldown, output `dist/admin` that Hono serves |

**Tech stack:**

| Layer | Choice |
|---|---|
| Framework | React |
| UI library | shadcn/ui + Tailwind CSS |
| Data fetching | TanStack Query |
| Table grid | `ag-grid-community` or `tanstack/react-table` |
| Build | Rolldown or Vite (bundled at `core` build time) |

**CLI:**

```
localbase dev          → serves admin UI at /_/admin automatically
localbase studio       → opens browser directly to admin UI (alias)
```

**Tasks:**

- [x] Create `packages/core/admin/` subfolder with React app
- [x] Add admin build step to `core` package.json (builds into `dist/admin/`)
- [x] Add Hono static file route `/_admin/*` serving `dist/admin/` assets
- [x] Add `GET /_api/admin/tables` endpoint (list all tables from schema)
- [x] Add `GET /_api/admin/:table/rows` endpoint (list rows with pagination, sort, search)
- [x] Add `POST /_api/admin/:table/rows` endpoint (insert row)
- [x] Add `PATCH /_api/admin/:table/rows/:id` endpoint (update row)
- [x] Add `DELETE /_api/admin/:table/rows/:id` endpoint (delete row)
- [x] Add `GET /_api/admin/schema` endpoint (return current schema as JSON)
- [x] Build table browser: sidebar table list + data grid
- [x] Build inline row editor (double-click cell → edit → save)
- [x] Build schema viewer panel (shows column names, types, constraints)
- [x] Add `localbase studio` CLI command (opens `http://localhost:5180/_/admin` in default browser)
- [x] Write integration tests: load admin, list tables, edit row, delete row
- [x] Update README with admin UI screenshot

---

### Phase 11: Scheduled Jobs

**Goal:** Define cron jobs in config, LocalBase runs them automatically.

**Config example:**

```ts
export default {
  tables: { ... },
  jobs: {
    cleanup_sessions: {
      schedule: "0 3 * * *",        // 3 AM daily
      handler: "./jobs/cleanup.ts", // path to job file
    },
    weekly_report: {
      schedule: "0 9 * * 1",        // 9 AM every Monday
      handler: "./jobs/report.ts",
    },
  },
};
```

**CLI:**

```
localbase jobs list              Show all registered jobs + next run time
localbase jobs run <name>        Manually trigger a job
localbase jobs logs <name>       Show run history for a job
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Job registry | `packages/core` | Loads jobs from config, validates schedule |
| Scheduler | `packages/core` | Runs jobs on cron schedule |
| Job runner | `packages/core` | Loads handler file, executes, captures output |
| Logs table | SQLite | Tracks run history |
| CLI commands | `packages/cli` | List, run, logs |

**Tasks:**

- [ ] Define `JobConfig` type in `shared` (name, schedule, handler path)
- [ ] Add `jobs` property to `LocalBaseConfig` type
- [ ] Create `_job_runs` table (id, job_name, started_at, ended_at, status, output, error)
- [ ] Pick cron parser library (`node-cron` or `croner`)
- [ ] Build scheduler that wakes up on next-job-due
- [ ] Build job runner: import handler module via jiti, call with `{ db }` context
- [ ] Wrap each run in try/catch, log to `_job_runs`
- [ ] Integrate scheduler into `dev` command (start with server)
- [ ] Implement `localbase jobs list` (name, schedule, next run, last run)
- [ ] Implement `localbase jobs run <name>` (manual trigger)
- [ ] Implement `localbase jobs logs <name>` (last N runs)
- [ ] Write tests: schedule, run, log

---

### Phase 9: Storage  ➡️  [Dedicated plan](./LOCALBASE-STORAGE.md)

> **Promoted to its own plan.** Storage is the last missing first-class data primitive and the one remaining phase with a genuinely dangerous security surface (uploads, path traversal, signed URLs). Full decision record, security model, API surface, and milestone breakdown (M1–M4) live in [`LOCALBASE-STORAGE.md`](./LOCALBASE-STORAGE.md). The summary below is kept for context.

**Goal:** File uploads/downloads with bucket abstraction.

**SDK example:**

```ts
await db.storage.from("avatars").upload(file);
// → { path: "avatars/<uuid>.jpg", storedName: "<uuid>", originalName: "reyansh.jpg", size, mime }

const url    = db.storage.from("avatars").getPublicUrl("reyansh.jpg");
const signed = await db.storage.from("documents").createSignedUrl("report.pdf", { expiresIn: 3600 });
```

**REST API:**

```
POST   /api/storage/:bucket              Upload file (multipart, auth required)
GET    /api/storage/:bucket/:filename    Download file (public bucket → open; private → auth or signed URL)
DELETE /api/storage/:bucket/:filename    Delete file (auth required)
GET    /api/storage/:bucket              List files in bucket (auth required)
```

**File layout:**

```
.localbase/
  data.db
  storage/
    avatars/
      <uuid>.jpg        # stored_name is always a server-generated UUID
    documents/
      <uuid>.pdf
```

**Key decisions (full rationale in the dedicated plan):** private-by-default buckets, UUID `stored_name` with original preserved as metadata, HMAC-SHA256 signed URLs, Hono multipart streamed to disk, storage root under the data dir. Four milestones: M1 engine+metadata → M2 REST API → M3 auth/signed URLs → M4 SDK + Admin browser.

---

## Decision Points (Defer Until Needed)

- **Auth for storage** — auth exists now (Phase 7); the public/private bucket decision is captured in Phase 9 (Decision #2).
- **Realtime row-level security** — without auth, all events go to all subscribers. Defer until auth exists.
- **Job retries** — if a job fails, should it retry? Defer; just log for now.
- **Storage quotas** — limit per-bucket size? Defer.
- **WebSocket scale** — single-process only for now. If we ever need multi-process, switch to Redis pubsub.

---

## Prerequisites

- Phase 7 (Auth) ✅ — requires MVP complete (Database + API + SDK foundation)
- Phase 8 (Realtime) ✅ — requires MVP complete
- Phase 9 (Storage) — independent, can ship anytime
- Phase 10 (Admin UI) ✅ — required MVP complete. Optional: Phase 7 (Auth) for login gate, Phase 9 (Storage) for file browser, Phase 8 (Realtime) for inspector.
- Phase 11 (Scheduled Jobs) — requires MVP complete

Phases 7–11 are independent — build in any order based on demand, except Admin UI benefits from earlier phases.
