# 🖥️ LocalBase Admin UI — Dedicated Plan

> Pulled out of `LOCALBASE-POST-MVP.md` Phase 10 into its own plan.
> This is the feature that moves LocalBase from "dev tool" to "platform."

---

## 🎯 Why this is a top-tier priority

Evidence from `COMPETITION.md`:

- In the feature matrix, **Admin UI is the one row where LocalBase is uniquely absent**. PocketBase, TrailBase, Supabase, Directus, and NocoDB all ship one.
- Listed as Honest Weakness #3: *"No admin UI. Competitors have this. LocalBase requires you to use the SDK or raw API."*
- The roadmap table: *"PocketBase's admin UI → LocalBase needs an admin UI eventually. **It is a major differentiator.**"*
- The core positioning tension: *"PocketBase feels more like a **product**; LocalBase feels more like a **dev tool**."* The Admin UI is what flips that perception.
- `LOCALBASE.md` (master vision) already lists "Admin Studio" as core module #6 and `localbase studio` as an MVP command — it was always meant to be first-class.

**Axis clarification:** Realtime is the biggest *capability* advancement (unlocks new app categories, but invisible until you build on it). The Admin UI is the biggest *perception / adoption / differentiation* advancement — it's the storefront, the screenshot, and the thing that makes the product feel real. Both matter; they're on different axes.

---

## 📌 Thesis

Ship a built-in dashboard at `http://localhost:5180/admin` that lets you browse tables, edit rows inline, inspect schema, and manage users — without writing a line of code. It is served by core, gated by admin auth, and writes through the `Database` class so every edit still fires realtime events.

---

## ✅ Decision Record (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Auth model** | `role` column on `_users` (`user` \| `admin`) + bootstrap | Per-user, auditable, single auth/JWT system. No second auth codebase to maintain. |
| 2 | **Bootstrap** | First user to sign up becomes admin; `localbase admin:promote <email>` for the rest | Works on fresh installs; reliable CLI path for existing installs that already have users. |
| 3 | **Package layout** | New `packages/admin`; built `dist/` embedded into `@localbase/core/dist/admin` at publish | Keeps `@localbase/core` lean (no React/Vite/Tailwind in its deps); `npm i @localbase/core` stays self-contained. |
| 4 | **Table grid** | `@tanstack/react-table` (headless) | ~10% the bundle of ag-grid; styles match shadcn/ui exactly; no visual clash. |
| 5 | **First cut scope** | P0 (table browser + inline row editor + schema viewer) **+ Auth Manager** | Auth Manager is nearly free — `Auth.createUser / listUsers / setPassword` already exist. |
| 6 | Admin API | Dedicated `/_api/admin/*`, gated by `requireAdmin`, writes through `Database` | Admin needs elevated rights (list tables, counts, real schema); writing through `Database` keeps realtime firing. |
| 7 | Schema source | Introspect via `PRAGMA` through `db.raw()` → new `db.introspect()` | Shows the *actual* DB (catches drift, reveals `_users`/`_sessions`), not just declared config. |
| 8 | Stack | React + Vite + Tailwind + shadcn/ui + TanStack Query | Matches master vision stack. |
| 9 | URL path | `/admin` (SPA + index.html fallback) | Cleanest; the post-MVP doc's `/_/admin` vs `/_admin/*` is contradictory, so we pick one. |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser: http://localhost:5180/admin                       │
│  React SPA (packages/admin → dist, embedded in core)        │
└─────────────────────────────────────────────────────────────┘
                         │  fetch (Bearer admin JWT)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Hono app (createServer)                                    │
│                                                             │
│   /admin/*            → serveStatic(embedded dist) + SPA    │
│   /_api/admin/*       → admin router  (requireAdmin gate)   │
│   /api/*              → public CRUD      (requireAuth, opt) │
│   /api/auth/*         → auth router                         │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Database class  (all admin writes go through here)         │
│   .introspect()  .select/insert/update/delete               │
│   emits "change" events → RealtimeServer broadcasts         │
└─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- The admin UI talks **only** to `/_api/admin/*` and `/api/auth/*`. It never hits public `/api/:table` directly.
- All admin mutations call `Database.insert/update/delete`, so **edits in the dashboard show up instantly to every realtime subscriber.** This is free because Phase 8 is done.
- The admin static bundle is **embedded into `@localbase/core` at publish time**, so a plain `localbase dev` serves the UI with no extra install.

---

## 🔐 Security Model: `role` on `_users`

An admin is just a user whose JWT carries `role: "admin"`. No second auth system.

**Schema change** (`auth/schema.ts`):
```ts
_users: {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  email: { type: "text", nullable: false, unique: true },
  password_hash: { type: "text", nullable: false },
  role: { type: "text", default: "'user'", nullable: false },   // NEW
  created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
}
```

**What changes:**
- `tokens.ts` — `signAccessToken` embeds `role`; `verifyAccessToken` exposes it in claims.
- `auth.ts` — `signUp` grants `admin` **only when `_users` is empty** (first-user bootstrap); `publicUser` surfaces `role`.
- `auth/middleware.ts` — new `requireAdmin(secret)` factory, parallels `requireAuth`, checks `claims.role === "admin"` → 403 otherwise.
- CLI — `localbase admin:promote <email>` / `admin:demote <email>` (reuses `Auth` class).

**Fallback when auth is disabled:** if `auth.enabled === false`, the admin API is ungated but we log a warning and recommend binding to `127.0.0.1`. (Open sub-decision: force localhost binding in this mode. See Risks.)

> ⚠️ **Verify before coding:** confirm `runMigrations` (in `migrate.ts`) handles additive `ALTER TABLE ... ADD COLUMN` for `_users`. It likely does (it diffs schema → DDL), but the first M2 task is to confirm and, if needed, add an additive-column path.

---

## 🌐 Admin API Surface (`/_api/admin/*`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_api/admin/schema` | Introspected schema for all tables (incl. system tables) |
| `GET` | `/_api/admin/tables` | List of table names + row counts |
| `GET` | `/_api/admin/tables/:table/rows` | Paginated/sorted/filtered rows → `{ rows, total }` |
| `POST` | `/_api/admin/tables/:table/rows` | Insert row (through `Database`) |
| `PATCH` | `/_api/admin/tables/:table/rows/:id` | Update row (through `Database`) |
| `DELETE` | `/_api/admin/tables/:table/rows/:id` | Delete row (through `Database`) |
| `GET` | `/_api/admin/users` | List users (Auth Manager) |
| `POST` | `/_api/admin/users` | Create user (`Auth.createUser`) |
| `POST` | `/_api/admin/users/:id/reset-password` | Reset password (`Auth.setPassword`) |
| `PATCH` | `/_api/admin/users/:id/role` | Promote/demote (`user` ↔ `admin`) |

All gated by `requireAdmin`. All return `{ data } | { error }` to match the existing API convention.

---

## 🎨 Frontend Architecture (`packages/admin`)

**Stack:** Vite · React · TypeScript · Tailwind · shadcn/ui · TanStack Query · @tanstack/react-table

**Views (first cut):**
- **Login** — email/password → stores admin JWT (same flow as app auth; just needs `role: admin`).
- **Table browser** — left sidebar (table list + row counts), main area = data grid (sort, paginate, search).
- **Inline row editor** — double-click cell → edit → blur/Enter → PATCH. "New row" + "delete row" actions.
- **Schema viewer** — collapsible panel: columns, types, constraints (PK, unique, nullable, FK).
- **Auth Manager** — users table: list, create, reset password, promote/demote.

**Stubbed nav** (badged "requires Phase X" until those land): Storage browser (P9), Realtime inspector (P8 — *actually ready to enable*), Jobs viewer (P11).

**Data layer:** TanStack Query against `/_api/admin/*`. Invalidates the relevant query key after each mutation so the grid refreshes.

**Dev workflow:** `pnpm --filter admin dev` runs Vite on `:5173`, proxying `/api` + `/_api` + `/realtime` → `:5180` for HMR. No rebuild-and-refresh loop.

---

## 🚀 Build Sequence (milestones)

Each milestone is independently shippable and verifiable.

### M1 — Backend foundation (no UI)
**Goal:** the admin API and static mount exist and respond.

**Files:**
- `packages/core/src/db.ts` — add `introspect(): IntrospectedSchema` (PRAGMA `table_info` + `foreign_key_list` + `index_list`).
- `packages/core/src/admin/router.ts` — schema + rows CRUD endpoints, writing through `Database`.
- `packages/core/src/admin/static.ts` — `serveStatic` mount at `/admin/*` + SPA fallback to `index.html`.
- `packages/core/src/index.ts` — export `createAdminRouter`, `introspect`.
- `packages/core/src/api.ts` — accept an `admin` option; mount admin router + static.
- `packages/cli/src/dev.ts` — pass `admin: { enabled: true }` through.

**Done when:** `curl http://localhost:5180/_api/admin/schema` returns JSON; `/admin/` serves a placeholder `index.html`.

### M2 — Role-based admin auth + gate
**Goal:** only admins can reach `/_api/admin/*`.

**Tasks:**
- [ ] Confirm `runMigrations` handles additive `ALTER TABLE ADD COLUMN` for `_users` (or add that path).
- [ ] Add `role` column to `AUTH_SCHEMA._users`.
- [ ] `tokens.ts`: `role` in access-token claims; surfaced on verify.
- [ ] `auth.ts`: first-user → admin bootstrap; `publicUser` includes `role`; add `setRole(email, role)`.
- [ ] `auth/middleware.ts`: `requireAdmin(secret)`.
- [ ] Admin router wired with `requireAdmin`.
- [ ] CLI `localbase admin:promote <email>` + `admin:demote <email>`.

**Done when:** first signup is admin; promote/demote works; a non-admin token gets `403` on `/_api/admin/*`; an admin token gets `200`.

### M3 — `packages/admin` scaffold
**Goal:** a live app shell talking to the real admin API.

**Tasks:**
- [ ] `packages/admin/package.json` (React, Vite, Tailwind, shadcn/ui, TanStack Query, react-table).
- [ ] `vite.config.ts` proxying `/api`, `/_api`, `/realtime` → `:5180`.
- [ ] App shell: sidebar nav, login view, token storage, auth redirect.
- [ ] Root layout + routing skeleton (table-browser, schema, users).

**Done when:** `pnpm --filter admin dev` shows the shell and renders data fetched from live `/_api/admin/schema`.

### M4 — P0 views
**Goal:** a usable dashboard.

**Tasks:**
- [ ] Table browser: sidebar (tables + counts) + data grid (sort, paginate, search).
- [ ] Inline cell editor → PATCH via `Database`.
- [ ] Add-row / delete-row actions.
- [ ] Schema viewer panel.
- [ ] Wire TanStack Query cache invalidation on every mutation.

**Done when:** a developer can view, create, edit, delete rows in the browser, and the edits propagate to realtime subscribers (verify with the Phase 8 WS).

### M5 — Auth Manager
**Goal:** user management from the UI.

**Tasks:**
- [ ] Users list, create-user dialog, reset-password, promote/demote.

**Done when:** admin can fully manage users without touching the CLI.

### M6 — Publish glue + `studio` CLI
**Goal:** zero-config for end users.

**Tasks:**
- [ ] Build step copies `packages/admin/dist` → `packages/core/dist/admin` on publish.
- [ ] `localbase studio` command → opens `http://localhost:5180/admin` in the default browser (alias of dev + open).
- [ ] README quickstart + screenshot.
- [ ] Integration tests: load admin, list tables, edit a row, delete a row.

**Done when:** a fresh `localbase dev` serves the full admin UI with no extra install; `localbase studio` opens it.

---

## ⚠️ Risks & Open Questions

1. **Additive migration for `_users`.** Must confirm `runMigrations` does `ALTER TABLE ADD COLUMN` (vs. drop+recreate). If it recreates, existing user data is at risk — must add a safe additive path first. *(First task in M2.)*
2. **Existing installs already have users.** First-user bootstrap won't fire for them. Mitigation: `localbase admin:promote <email>` is the documented path; print a hint on first admin route hit when no admin exists.
3. **No-auth mode.** When `auth.enabled === false`, the admin API is ungated. Open decision: force `127.0.0.1` binding in this mode? (Recommended.)
4. **Bundle bloat at publish.** Embedding the React bundle increases `@localbase/core` install size. Acceptable for a self-contained platform; revisit if it exceeds ~1.5 MB gzipped.
5. **Schema drift (config vs. actual DB).** Introspection surfaces the truth; the UI should flag when declared config ≠ actual schema. (Nice-to-have for M4; not blocking.)

---

## 🚫 Out of Scope (this plan)

- Schema editing / migrations from the UI (config-first stays the philosophy).
- GraphQL.
- Storage browser, Jobs viewer — gated on Phases 9 and 11. The **Realtime inspector** is *not* blocked (Phase 8 is done) but is a P2 stretch for after M5.
- Multi-process WebSocket scale.

---

## 🔗 Dependencies

- **Requires:** MVP (Database + API + SDK) ✅, Phase 7 Auth ✅.
- **Benefits from (already done):** Phase 8 Realtime — admin edits auto-broadcast to subscribers.
- **Optional later integrations:** Phase 9 Storage (file browser), Phase 11 Jobs (run viewer).

---

## 📊 First-cut success metric

> A new user runs `localbase init && localbase dev`, opens `http://localhost:5180/admin`, logs in, and manages their data — all without opening a terminal again or reading the SDK docs.
