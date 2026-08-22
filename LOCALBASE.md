# 🗄️ LocalBase (Local Supabase Alternative)

> **Status: historical vision / architecture sketch.** This document predates
> the current monorepo layout and shipped feature set. For accurate install,
> CLI, and API docs use [docs/](./docs/README.md) and the root [README](./README.md).
> For launch status see [`TASKS.md`](./TASKS.md) and [`LAUNCH.md`](./LAUNCH.md).
>
> **As-built notes (developer preview):** SQLite only (no Postgres yet); HTTP
> via **Hono** (not Fastify); no Drizzle ORM; Jobs and manual backup/restore
> **have shipped**; package layout is `packages/{shared,core,sdk,cli,admin,e2e}`.

## 🎯 Vision

LocalBase is a **local-first backend platform** that provides:

* Database
* Authentication
* Storage
* Realtime
* API layer
* Admin dashboard

All running locally and deeply integrated with DevDesk.

The goal is to create a lightweight, developer-friendly backend platform inspired by Supabase, but optimized for local development workflows.

---

# 🏗️ High-Level Architecture

```txt
Project
  ↓
LocalBase Engine
  ↓
Database (SQLite/Postgres)
  ↓
Auth System
  ↓
Storage Engine
  ↓
Realtime Engine
  ↓
API Layer
  ↓
SDK + Admin Studio
```

---

# 🧩 Core Modules

---

## 🗃️ 1. Database Layer

Responsible for managing application data.

### Features

* Table creation
* Schema inspection
* Migrations
* Data seeding
* Query execution
* Table browser
* Relationship management

### CLI Commands

```bash
localbase db create <table>
localbase db migrate
localbase db seed
localbase db reset
```

### MVP Database Choice

Start with:

* SQLite

Future support:

* PostgreSQL

---

## 🔐 2. Auth System

Handles authentication and authorization.

### Features

* Email/password login
* JWT sessions
* Refresh tokens
* Role-based access control (RBAC)
* Permission system

### Example API

```ts
auth.signUp(email, password)

auth.signIn(email, password)

auth.getUser()

auth.signOut()
```

### Future Features

* OAuth providers
* Magic links
* Multi-factor authentication

---

## 📦 3. Storage System

Local file storage with bucket abstraction.

### Features

* File upload/download
* Public & private buckets
* Metadata tracking
* Signed URLs
* File previews

### Example Structure

```txt
.localbase/
  storage/
    avatars/
    documents/
    uploads/
```

### Example API

```ts
storage
  .from("avatars")
  .upload(file)
```

---

## ⚡ 4. Realtime Engine

Provides live data synchronization.

### Implementation

* WebSockets
* Event bus
* Subscription system

### Features

* Table subscriptions
* Row updates
* Presence events
* Broadcast channels

### Example

```ts
db.subscribe("messages", (event) => {
  console.log(event)
})
```

---

## 🌐 5. API Layer

Automatically generates APIs from database schema.

### Features

* REST endpoints
* CRUD operations
* Filtering
* Pagination
* Query validation

### Example

```txt
GET /api/users
POST /api/users
PATCH /api/users/:id
DELETE /api/users/:id
```

---

## 🧑‍💻 6. Admin Studio

A DevDesk-integrated management dashboard.

### Features

* Table viewer/editor
* Auth management
* Storage browser
* Logs viewer
* Realtime inspector
* API key management

### UI Goals

* Fast
* Minimal
* Modern
* Local-first

### Stack

* React
* shadcn/ui
* TanStack Query

---

## 📦 7. SDK

Client library for interacting with LocalBase.

### Example Usage

```ts
const client = createLocalBaseClient()

const users = await client
  .from("users")
  .select()

await client.auth.signIn(email, password)

await client.storage
  .from("avatars")
  .upload(file)
```

### SDK Goals

* Type-safe
* Lightweight
* Familiar API
* Great DX

---

# 🧪 MVP Scope

## CLI Commands

```bash
localbase init
localbase dev
localbase studio
```

## MVP Features

* SQLite database
* Basic migrations
* Auth system
* Local file storage
* REST API generation
* Admin UI
* SDK

---

# 🛠️ Tech Stack

| Layer    | Technology (as-built) |
| -------- | ------------------ |
| Runtime  | Node.js ≥ 22       |
| Language | TypeScript         |
| Database | SQLite (`better-sqlite3`) — Postgres still future |
| API      | **Hono**           |
| ORM      | None (SQL via core `Database` class) |
| Realtime | WebSockets (`ws`)  |
| UI       | React + shadcn/ui + Tailwind (Admin Studio) |
| Auth     | JWT + Argon2id (`@node-rs/argon2`) |
| CLI      | Commander (`@localbase/cli`) |
| Jobs     | `croner` + jiti handlers (shipped) |
| Storage  | Local disk under `.localbase/storage/` (shipped) |

---

# 📁 Folder structure (as-built monorepo)

```txt
localbase/
  packages/
    shared/    @localbase/shared
    core/      @localbase/core (db, auth, storage, realtime, jobs, admin embed)
    sdk/       @localbase/sdk
    cli/       @localbase/cli  (binary: localbase)
    admin/     private React SPA → embedded into core at build
    e2e/       Playwright suite
  examples/
  docs/
```

---

# 🔒 Security Considerations

* Argon2 password hashing
* JWT expiration
* Permission validation
* File access control
* Rate limiting
* Secure token storage

---

# 🚀 Future Enhancements

## Database

* PostgreSQL support
* Replication
* Backups

## Functions

* Edge/serverless functions
* Scheduled jobs

## APIs

* GraphQL
* RPC

## Collaboration

* Cloud sync
* Multi-user environments

## Developer Experience

* Visual schema builder
* Migration generator
* Live query inspector

---

# 🔗 DevDesk Integration

LocalBase integrates into DevDesk as:

* Database explorer
* Backend manager
* Auth dashboard
* Storage browser
* Realtime inspector

---

# 🧠 Final Vision

```txt
DevDesk
 ├─ Performance Engine
 ├─ AgentCore
 └─ LocalBase
```

A complete local developer operating system.

---

# ✅ End of Spec
