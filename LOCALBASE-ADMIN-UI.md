# 🖥️ LocalBase Admin UI — Dedicated Plan

> **Status: complete (historical plan).** Phase 10 has shipped. Prefer the root
> [README](./README.md) “Admin UI” section for current usage. Studio URL:
> `http://localhost:5180/admin/`.

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
| 1 | **Auth model** | `role` column on `_users` (`user` \| `admin` \| `owner`) + bootstrap | Per-user, auditable, single auth/JWT system. No second auth codebase to maintain. |
| 2 | **Bootstrap** | First user to sign up becomes owner; `localbase admin promote <email>` grants admin to others | Works on fresh installs; reliable CLI path for existing installs that already have users. |
| 3 | **Package layout** | New `packages/admin`; built `dist/` embedded into `@localbase/core/dist/admin` at publish | Keeps `@localbase/core` lean (no React/Vite/Tailwind in its deps); `npm i @localbase/core` stays self-contained. |
| 4 | **Table grid** | `@tanstack/react-table` (headless) | ~10% the bundle of ag-grid; styles match shadcn/ui exactly; no visual clash. |
| 5 | **First cut scope** | P0 (table browser + inline row editor + schema viewer) **+ Auth Manager** | Auth Manager is nearly free — `Auth.createUser / listUsers / setPassword` already exist. |
| 6 | Admin API | Dedicated `/_api/admin/*`, gated by `requireAdmin` from the first backend milestone, writes through `Database` | Admin needs elevated rights (list tables, counts, real schema); writing through `Database` keeps realtime firing. Never ship working admin mutations without admin auth. |
| 7 | Schema source | Introspect via `PRAGMA` through `db.raw()` → new `db.introspect()` | Shows the *actual* DB (catches drift, reveals `_users`/`_sessions`), not just declared config. |
| 8 | Stack | React + Vite + Tailwind + shadcn/ui + TanStack Query | Matches master vision stack. |
| 9 | URL path | `/admin` (SPA + index.html fallback) | Cleanest; the post-MVP doc's `/_/admin` vs `/_admin/*` is contradictory, so we pick one. |
| 10 | No-auth mode | Admin API is localhost-only unless explicitly started with an unsafe public flag | `auth.enabled === false` must never accidentally expose an ungated admin API on the LAN/internet. |
| 11 | Production exposure | Admin UI is enabled by default in `localbase dev`; deployed/public serving requires explicit config | Keeps the local-first workflow simple while avoiding accidental public admin surfaces. |

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

Admins and the owner use the same JWT-based auth system. The owner has admin access but cannot be demoted, and another admin cannot reset the owner's password.

`requireAdmin` must not trust only the JWT role claim. It should verify the session/user still exists and read the current role from `_users` before allowing access, so demotion takes effect immediately even if an old access token still contains `role: "admin"`.

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
- `auth.ts` — `signUp` grants `owner` **only when `_users` is empty** (first-user bootstrap); `publicUser` surfaces `role`.
- `auth/middleware.ts` — `requireAdmin(secret)` validates token/session, loads the current user role from DB, and accepts `admin` or `owner`.
- CLI — `localbase admin promote <email>` / `admin:demote <email>` (reuses `Auth` class).

**Fallback when auth is disabled:** if `auth.enabled === false`, the admin API is ungated **only when the server is bound to `127.0.0.1` / `localhost`**. Starting an ungated admin API on `0.0.0.0` or another public interface must fail unless the user passes an explicit unsafe flag such as `--admin-unsafe-public`.

**Token storage / CSRF decision:** first cut uses `Authorization: Bearer <token>` from the admin SPA, not ambient cookies. This avoids CSRF for admin mutations. Keep the access token short-lived, avoid injecting user content as HTML, and treat any future switch to cookies as requiring CSRF tokens.

**Admin lockout rules:** both UI and CLI must prevent deleting/demoting the last admin. Self-demotion should require an explicit confirmation in the UI and should still be blocked if it would leave zero admins.

> ⚠️ **Verify before coding:** confirm `runMigrations` (in `migrate.ts`) handles additive `ALTER TABLE ... ADD COLUMN` for `_users`. It likely does (it diffs schema → DDL), but the first M1 task is to confirm and, if needed, add an additive-column path before any role/auth changes ship.

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
| `GET` | `/api/auth/admin-registration` | Public owner-bootstrap status |
| `POST` | `/api/auth/admin-requests` | Submit a pending admin-account request |
| `GET` | `/_api/admin/admin-requests` | Owner-only paginated request list |
| `POST` | `/_api/admin/admin-requests/:id/approve` | Owner-only approval; creates the admin |
| `DELETE` | `/_api/admin/admin-requests/:id` | Owner-only rejection |

Admin request bodies are `{ email, password }`; successful submission returns
`202` with `{ id, email, created_at }`. The list response is
`{ requests, total }` and accepts bounded `limit`/`offset` parameters. Approval
returns the created public user with `201`; rejection returns `{ deleted: true }`.
Validation failures return `400`, duplicates and stale bootstrap attempts return
`409`, missing requests return `404`, and non-owner administrators receive
`403`. The generic system-table row endpoint refuses `_admin_requests` reads so
password hashes cannot bypass the redacted owner API.

All gated by `requireAdmin`. All return `{ data } | { error }` to match the existing API convention.

**Generic row-write constraints:** `POST/PATCH/DELETE /tables/:table/rows...` are for user data tables only. M1 intentionally rejects direct writes to `_`-prefixed system tables (`_users`, `_sessions`, later `_files`, etc.); those resources must be mutated through dedicated admin endpoints so auth/storage invariants are preserved. `PATCH` and `DELETE` require the target table to have exactly one primary key column because the route identifies rows as `:id`.

**SQLite/query safety rules:**
- Table names, column names, sort columns, and filter columns must be validated against `db.introspect()` before any SQL is generated. Never interpolate unchecked identifiers.
- Identifier quoting must be centralized and used for every validated table/column name.
- Values must always be bound parameters, including filters/search and primary key values.
- Sort direction is allowlisted to `asc` / `desc`; `limit` and `offset` are numeric, bounded, and defaulted.
- `sqlite_%` internal tables, views, virtual tables, and `_`-prefixed system tables are read-only unless a dedicated endpoint explicitly supports them.
- Tables without a primary key are browse-only. Composite primary keys are browse-only in M1. Single text/integer primary keys are editable; other primary key shapes need an explicit support decision.

**Operational safety rules:**
- Admin routes should set `Cache-Control: no-store` for API responses and avoid caching `index.html` aggressively during dev.
- Failed admin auth attempts should return generic errors and be safe to rate-limit later.
- Login brute-force/rate limiting belongs to the shared auth roadmap, but admin launch should at least document the risk and keep public exposure opt-in.

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

**Editor UX constraints:** distinguish `null` from empty string, render booleans/dates/numbers with type-aware inputs where obvious, show backend validation errors inline, and keep large text/JSON values editable without breaking the grid. Unsupported column/table shapes should be clearly marked read-only instead of failing late.

**Dev workflow:** `pnpm --filter admin dev` runs Vite on `:5173`, proxying `/api` + `/_api` + `/realtime` → `:5180` for HMR. No rebuild-and-refresh loop.

---

## 🚀 Build Sequence (milestones)

Each milestone is independently shippable and verifiable.

### M1 — Backend + auth foundation (no UI)
**Goal:** the admin API and static mount exist and respond, with admin auth enforced before any row CRUD is enabled.

**Files:**
- `packages/core/src/auth/schema.ts` — add `role` column to `_users` after confirming additive migration safety.
- `packages/core/src/auth/tokens.ts` — include `role` in access-token claims.
- `packages/core/src/auth/auth.ts` — first-user admin bootstrap; expose `role` in `publicUser`.
- `packages/core/src/auth/middleware.ts` — add `requireAdmin(secret)` and verify current DB role, not only JWT claims.
- `packages/core/src/db.ts` — add `introspect(): IntrospectedSchema` (PRAGMA `table_info` + `foreign_key_list` + `index_list`).
- `packages/core/src/admin/router.ts` — schema + rows CRUD endpoints, writing through `Database`.
- `packages/core/src/admin/system-tables.ts` — classify `_`-prefixed system tables and block generic row writes to them.
- `packages/core/src/admin/static.ts` — `serveStatic` mount at `/admin/*` + SPA fallback to `index.html`.
- `packages/core/src/index.ts` — export `createAdminRouter`, `introspect`.
- `packages/core/src/api.ts` — accept an `admin` option; mount admin router + static.
- `packages/cli/src/dev.ts` — pass `admin: { enabled: true }` through.

**M1 security posture:** no working admin mutation route exists without `requireAdmin`. If role support or safe `_users` migration is not ready yet, M1 may expose only static `/admin/` and read-only placeholder/health endpoints. Generic writes to system tables are blocked regardless.

**Done when:** an admin token can call `/_api/admin/schema`; a non-admin token gets `403`; `/admin/` serves a placeholder `index.html`; user-table row CRUD works through `Database`; direct writes to `_users`/`_sessions` return `403`; unsafe public no-auth startup is rejected unless explicitly opted in.

### M2 — Admin auth completion
**Goal:** finish role management, CLI promotion, and lockout protections.

**Tasks:**
- [x] Add `Auth.setRole(email, role)` / equivalent internal role update method.
- [x] Ensure admin router wiring cannot be constructed without `requireAdmin` when mutations are enabled.
- [x] Prevent deleting/demoting the last admin; require confirmation for self-demotion.
- [x] CLI `localbase admin promote <email>` + `admin:demote <email>`.

**Done when:** first signup is admin; promote/demote works; demotion takes effect immediately for existing tokens; a non-admin token gets `403` on `/_api/admin/*`; an admin token gets `200`; last-admin lockout is enforced.

### M2.5 — Admin API hardening tests
**Goal:** lock down the dangerous generic API surface before building UI on top of it.

**Tasks:**
- [x] Tests for table/column/sort/filter allowlisting and identifier quoting.
- [x] Tests for bounded pagination and parameterized search/filter values.
- [x] Tests for blocking `_`-prefixed, `sqlite_%`, views, virtual tables, no-PK tables, and composite-PK mutations.
- [x] Tests for auth failures, stale demoted tokens, no-auth localhost behavior, and unsafe public binding rejection.

**Done when:** backend admin tests cover the SQL-injection and authorization surfaces independently of the React UI.

### M3 — `packages/admin` scaffold
**Goal:** a live app shell talking to the real admin API.

**Tasks:**
- [x] `packages/admin/package.json` (React, Vite, Tailwind, shadcn/ui, TanStack Query, react-table).
- [x] `vite.config.ts` proxying `/api`, `/_api`, `/realtime` → `:5180`.
- [x] App shell: sidebar nav, login view, token storage, auth redirect.
- [x] Root layout + routing skeleton (table-browser, schema, users).

**Done when:** `pnpm --filter admin dev` shows the shell and renders data fetched from live `/_api/admin/schema`.

### M4 — P0 views
**Goal:** a usable dashboard.

**Tasks:**
- [x] Table browser: sidebar (tables + counts) + data grid (sort, paginate, search).
- [x] Inline cell editor → PATCH via `Database`.
- [x] Add-row / delete-row actions.
- [x] Schema viewer panel.
- [x] Wire TanStack Query cache invalidation on every mutation.

**Done when:** a developer can view, create, edit, delete rows in the browser, and the edits propagate to realtime subscribers (verify with the Phase 8 WS).

### M5 — Auth Manager
**Goal:** user management from the UI.

**Tasks:**
- [x] Users list, create-user dialog, reset-password, promote/demote.

**Done when:** admin can fully manage users without touching the CLI.

### M6 — Publish glue + `studio` CLI
**Goal:** zero-config for end users.

**Tasks:**
- [x] Build step copies `packages/admin/dist` → `packages/core/dist/admin` on publish. (Wired via `prebuild`/`postbuild`/`prepublishOnly` scripts in `@localbase/core`; the actual copy lives in `packages/core/build/copy-admin-bundle.mjs`.)
- [x] Package verification test confirms the published/tarball artifact contains `dist/admin/index.html` and assets. (`packages/core/build/verify-admin-bundle.mjs` runs `npm pack --dry-run --json` and asserts the file list; the matching in-test suite is `src/admin/static-bundle.test.ts`.)
- [x] `localbase studio` command → opens `http://localhost:5180/admin` in the default browser (alias of dev + open). (`packages/cli/src/studio.ts`; `localbase dev --open` works too.)
- [x] README quickstart + screenshot. (Quickstart in the root `README.md`; screenshot slot is reserved in this doc — drop a `docs/admin-ui.png` reference when one is captured.)
- [x] Integration tests: load admin, list tables, edit a row, delete a row. (`packages/core/src/admin/static-bundle.test.ts` — the `M6 — end-to-end admin flow` describe block.)

**Done when:** a fresh `localbase dev` serves the full admin UI with no extra install; `localbase studio` opens it.

**Screenshot:** `docs/admin-ui.png` is referenced from the root `README.md` (tables overview in Admin Studio). Optional data-grid shot: `docs/admin-ui-table.png`.

---

## ⚠️ Risks & Open Questions

1. **Additive migration for `_users`.** Must confirm `runMigrations` does `ALTER TABLE ADD COLUMN` (vs. drop+recreate). If it recreates, existing user data is at risk — must add a safe additive path first. *(First task in M1.)*
2. **Existing installs already have users.** First-user bootstrap won't fire for them. Mitigation: `localbase admin promote <email>` is the documented path; print a hint on first admin route hit when no admin exists.
3. **No-auth mode.** When `auth.enabled === false`, the admin API is ungated only on localhost. Public binding must fail unless an explicit unsafe flag is passed.
4. **Bundle bloat at publish.** Embedding the React bundle increases `@localbase/core` install size. Acceptable for a self-contained platform; revisit if it exceeds ~1.5 MB gzipped.
5. **Schema drift (config vs. actual DB).** Introspection surfaces the truth; the UI should flag when declared config ≠ actual schema. (Nice-to-have for M4; not blocking.)
6. **Audit trail.** Admin mutations are high-impact. Not required for first cut, but a P1 follow-up should add an `_audit_log` or equivalent with actor, action, resource, row id, timestamp, and optional before/after metadata.
7. **Large tables.** Exact row counts and broad search can become slow. M1 should bound pagination and keep search simple; later versions can add approximate counts/index hints if needed.

---

## 🚫 Out of Scope (this plan)

- Schema editing / migrations from the UI (config-first stays the philosophy).
- GraphQL.
- Storage browser, Jobs viewer — gated on Phases 9 and 11. The **Realtime inspector** is *not* blocked (Phase 8 is done) but is a P2 stretch for after M5.
- Multi-process WebSocket scale.
- Full audit log UI. Backend audit logging is a P1 hardening follow-up.

---

## 🔗 Dependencies

- **Requires:** MVP (Database + API + SDK) ✅, Phase 7 Auth ✅.
- **Benefits from (already done):** Phase 8 Realtime — admin edits auto-broadcast to subscribers.
- **Integrations:** Phase 9 Storage (file browser) and Phase 11 Jobs (run viewer) have shipped.

---

## 📊 First-cut success metric

> A new user runs `localbase init && localbase dev`, opens `http://localhost:5180/admin`, logs in, and manages their data — all without opening a terminal again or reading the SDK docs.
