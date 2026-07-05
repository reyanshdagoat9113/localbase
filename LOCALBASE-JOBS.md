# ⏰ LocalBase Scheduled Jobs — Dedicated Plan

> Pulled out of `LOCALBASE-POST-MVP.md` Phase 11 into its own plan.
> Define cron jobs in config; LocalBase runs them automatically, logs every run, and exposes a run viewer in the dashboard.

---

## 🎯 Why this is a priority

Scheduled jobs close the loop on "things a backend does for you." Once it ships, a LocalBase project covers the full set of recurring background work that developers otherwise hand off to a separate worker process, an OS crontab, or a third-party scheduler. It is the last item in the post-MVP priority order and the natural follow-up to the data primitives (data, auth, realtime, storage) and the Admin UI.

Evidence from `COMPETITION.md` and the existing plans:

- Supabase (pg_cron + Edge Functions), PocketBase (cron hooks in Go), Appwrite (Functions + schedules), and Directus (Flows + scheduled operations) all ship a cron/background layer. LocalBase currently has none.
- `LOCALBASE-POST-MVP.md` lists Scheduled Jobs as the next genuinely-useful, simpler-scope phase after the perception-heavy ones (realtime, admin UI, storage) shipped.
- The Admin UI already reserves a **Jobs viewer** nav item gated on "Phase 11" (`packages/admin/src/App.tsx`), and `LOCALBASE-ADMIN-UI.md` lists it as an optional later integration. This plan unblocks that stub.
- The `_job_runs` table is **already pre-registered** in the admin system-table write-gate (`packages/core/src/admin/system-tables.ts`), explicitly annotated "owned by Phase 11 (not yet implemented)." The surface is waiting for the implementation.

**Axis clarification:** unlike realtime (a *capability* unlock) or the Admin UI (a *perception* win), Jobs is a *convenience/completeness* feature — it removes the "I need a separate worker process for a nightly cleanup" objection. Scope is intentionally small: cron config in `localbase.config.ts`, a scheduler process inside `localbase dev`, a run-history table, CLI inspection, and a dashboard viewer. No retries, no queues, no distributed scheduling (see Out of Scope).

---

## 📌 Thesis

A `jobs` map in `localbase.config.ts` maps a name to `{ schedule, handler }`. On `localbase dev` startup, a `Scheduler` process (lived alongside the realtime server, not inside the HTTP router) parses each schedule, wakes on next-due, imports the handler file via the same `jiti` loader already used for config, and calls it with `{ db, log, name }`. Every run — scheduled or manual — is recorded in `_job_runs`. The Admin UI and CLI read that table to show history and next-run times. Writing runs through `Database.insert` so realtime broadcasts run-status changes to the dashboard for free.

---

## ✅ Decision Record (proposed — confirm or override before M1)

| # | Decision | Proposed choice | Rationale |
|---|---|---|---|
| 1 | **Cron library** | `croner` (single-file, zero-dep, full TypeScript types, ESM-native, exposes `nextRun()` for free) | `node-cron` is callback-only, doesn't expose next-run without re-implementing a parser, and has no first-class ESM/types. We need next-run for `jobs list` and the admin viewer; `croner` gives it directly. |
| 2 | **Schedule format** | Standard 5-field cron (`m h dom mon dow`), validated at startup | Matches the config examples in the post-MVP doc (`"0 3 * * *"`, `"0 9 * * 1"`) and the mental model every developer already has. Seconds-precision is rejected; sub-minute jobs are out of scope. |
| 3 | **Timezone** | Optional per-job `timezone` (IANA name, e.g. `"America/New_York"`); default = server local | "3 AM daily" is meaningless without a timezone. `croner` accepts IANA names natively. Per-job granularity lets multi-region teams be explicit. |
| 4 | **Handler loading** | `jiti` (already a CLI dep; add to core) with `interopDefault: true`, exactly like the config loader | Reuses the proven loader. A handler file default-exports an async function. No new dynamic-import mechanism. |
| 5 | **Handler context** | `{ db, log, name }` where `db` is the live `Database` instance and `log(line)` appends to the run's `output` | Jobs are server-side system code: they get full DB access through the same class realtime/admin use, so writes emit `change` events. `db` bypasses HTTP-layer RLS **by design** (system cron jobs are not user requests). |
| 6 | **Where jiti lives** | Add `jiti` to `packages/core` deps; the runner lives in core (it needs the `Database` for `{ db }`) | Keeps the handler-loading + `{ db }` wiring in one place. CLI already has jiti for config; core gets it for handlers. |
| 7 | **Where the scheduler runs** | In the CLI `dev` command, next to the realtime server — **not** inside `createServer` | A scheduler is a long-running process (timers), not an HTTP router. This mirrors how `createRealtimeServer` is wired in `dev.ts`. `createServer` only grows a new admin router section for the run viewer. |
| 8 | **Concurrency / overlap** | In-memory `Set` of running job names; if a job is still running when its next schedule fires, **skip** that firing (log a `skipped` note) and wait for the next | Safe default; avoids unbounded parallelism for a slow job on a tight schedule. No queueing. |
| 9 | **Missed runs (server was down)** | **No backfill.** When the scheduler starts, it computes the next *future* run and does not replay missed ones | Matches the "keep it simple" philosophy and the deferred "job retries" decision point in `LOCALBASE-POST-MVP.md`. A reconcile/retry layer is explicitly out of scope. |
| 10 | **`_job_runs` ownership** | Created by `Database` constructor (conditional on `jobs` config), never writable through the generic admin row-CRUD API | Mirrors `_files`/`_users`. Already pre-registered in the admin system-table gate, so direct writes are already blocked. Runs are only ever written by the runner via `db.insert("_job_runs", ...)`. |
| 11 | **Manual run surface** | `localbase jobs run <name>` (CLI) **and** `POST /_api/admin/jobs/:name/run` (admin API), both gated to *registered* job names only | Manual run never loads an arbitrary handler path — it only triggers a pre-validated, config-declared job. Admin route is gated by `requireAdmin`. |
| 12 | **Config shape** | `jobs?: Record<string, JobConfig>` directly on `LocalBaseConfig` (a map, matching the `tables:` precedent and the post-MVP config example) | Global job options (default timezone, global concurrency cap) can land as a sibling `jobsOptions?` field later if needed; first cut is just the map. |

> ⚠️ These are recommended defaults to confirm, not yet locked. Lock them (or override) before the first PR. **Decision #5 (full DB access, RLS bypass)** and **#11 (manual run limited to registered names)** are the security-critical ones — do not weaken them without a recorded reason.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  localbase.config.ts                                        │
│    jobs: {                                                   │
│      cleanup_sessions: { schedule: "0 3 * * *",             │
│                           handler: "./jobs/cleanup.ts" }    │
│    }                                                         │
└─────────────────────────────────────────────────────────────┘
                          │  loadConfig (jiti, validates schedule + handler path)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  CLI dev command (packages/cli/src/dev.ts)                  │
│   loadConfig → new Database(...) → createApi(...) → serve   │
│   then:  createScheduler({ db, config: config.jobs, cwd })  │
│           (sits next to createRealtimeServer)                │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Scheduler (packages/core/src/jobs/scheduler.ts)            │
│   .start()  → for each job: croner.Cron(schedule, cb)       │
│               compute nextRun(); wake on due                │
│   .runNow(name)  → invoke runner immediately (manual)       │
│   .stop()   → clear timers                                   │
│   concurrency: skip firing if name in runningSet            │
└─────────────────────────────────────────────────────────────┘
                          │  on due (or manual)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Job runner (packages/core/src/jobs/runner.ts)              │
│   1. insert _job_runs { status: "running", started_at }     │
│   2. jiti.import(handlerPath) → default export fn           │
│   3. call handler({ db, log, name })                        │
│   4. update _job_runs { status: "success"|"failed",         │
│                         ended_at, duration_ms, output, error}│
│   (writes go through Database.insert/update → change events)│
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  _job_runs table (SQLite, _-prefixed system table)          │
│   read by: CLI (localbase jobs list/logs)                   │
│            admin API (GET /_api/admin/jobs*) → dashboard    │
│            realtime (auto-broadcasts on each row write)     │
└─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- Jobs are **declared in config only.** There is no runtime registration API; the map is the source of truth, loaded and validated at startup.
- Handler files are loaded **relative to the project cwd** via the same `jiti` + `interopDefault` path the config loader uses. They are trusted operator code — exactly as `localbase.config.ts` is — never remotely supplied.
- Every run — scheduled, manual (CLI), or manual (admin) — funnels through the **same** `JobRunner.run(name)`, so `_job_runs` is always consistent.
- Run-status writes go through `Database.insert/update`, so the **realtime server broadcasts run changes for free** (Phase 8). The admin Jobs viewer can live-update without polling.
- `_job_runs` is a `_`-prefixed system table: `resetDatabase()` preserves it, and the generic admin row-CRUD endpoints refuse to write to it.

---

## 🔐 Security Model

**Code execution trust boundary.** A job handler is arbitrary code with full `Database` access. It is loaded from the filesystem the operator controls (`./jobs/cleanup.ts`), exactly like `localbase.config.ts` itself. LocalBase never loads a handler path from an untrusted source: the manual-run endpoints (CLI and `POST /_api/admin/jobs/:name/run`) accept only a **registered job name**, never a path. There is no remote "run this URL/file" surface.

**Database access & RLS.** Handlers receive the live `Database` instance and call `db.select/insert/update/delete` directly. RLS (`policies`) is enforced at the HTTP layer in `createServer`, **not** in the `Database` class — so system jobs intentionally bypass it. This is correct: a nightly session-cleanup job is not a user request and must touch rows regardless of owner. Document this loudly so developers don't expect `ownerColumn` stamping inside jobs.

**Admin gate.** The run-viewer and manual-trigger endpoints live under `/_api/admin/jobs/*` and inherit `requireAdmin` (re-reads the live `role` from `_users`, so demotions take effect immediately). When auth is disabled, the admin API is ungated **only on localhost**, matching the Admin UI's existing rule.

**Output sensitivity.** `_job_runs.output` and `.error` store whatever the handler returns/logs or whatever an exception serialized. Operators should not `log()` secrets. This is documented, not enforced — same posture as any log table.

**Concurrency.** A slow job on a tight schedule must not pile up. The in-memory `runningSet` skips an overlapping firing rather than queueing it, bounding work to one concurrent execution per job name.

---

## 🌐 Admin API Surface (`/_api/admin/jobs/*`)

All gated by `requireAdmin` (inherits the existing admin router gate). All return `{ data } | { error }`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/_api/admin/jobs` | List registered jobs: `{ name, schedule, timezone, nextRun, lastRun, lastStatus }` |
| `GET` | `/_api/admin/jobs/:name/runs` | Paginated run history for a job → `{ runs, total }` (newest first) |
| `POST` | `/_api/admin/jobs/:name/run` | Trigger a registered job now → `{ runId }` (runs async; status observable via `_job_runs`/realtime) |

**Name safety rules (non-negotiable):**

- `:name` must resolve to a key in the in-memory job registry. An unknown name returns `404`, never a filesystem lookup. `POST .../run` **never** accepts a path.
- These endpoints are read/trigger only. There is no `PATCH`/`DELETE` on `_job_runs` — history is append-only by the runner.

---

## 🎛️ Config & Handler Shape

**Config types** (added to `packages/shared/src/index.ts`):

```ts
export interface JobConfig {
  /** Standard 5-field cron: "m h dom mon dow". e.g. "0 3 * * *" = 3 AM daily. */
  schedule: string;
  /** Path (relative to project cwd) to a handler file. Default-exports an async fn. */
  handler: string;
  /** IANA timezone, e.g. "America/New_York". Default: server local. */
  timezone?: string;
  /** Set false to register-but-pause. Default: true. */
  enabled?: boolean;
  /** Free-text note shown in `jobs list` and the dashboard. */
  description?: string;
}

export interface LocalBaseConfig {
  // ...existing fields...
  /** Cron-scheduled jobs. Keys are job names. */
  jobs?: Record<string, JobConfig>;
}
```

**Handler contract** (types live in `packages/core/src/jobs/`, since `db` is a core type):

```ts
// jobs/handler.ts — what a developer writes
import type { JobHandler } from "@localbase/core";

export default (async ({ db, log, name }) => {
  const deleted = db.delete("_sessions", { expires_at: { lt: new Date().toISOString() } });
  log(`deleted ${deleted} expired sessions`);
}) satisfies JobHandler;
```

```ts
// packages/core/src/jobs/types.ts — the contract
import type { Database } from "../db";

export interface JobContext {
  /** Live Database instance. Full access; bypasses HTTP-layer RLS by design. */
  db: Database;
  /** Append a line to this run's `output`. */
  log: (line: string) => void;
  /** The job's registered name (key from the `jobs` config map). */
  name: string;
}

export type JobHandler = (ctx: JobContext) => void | Promise<void>;
```

The handler's resolved **return value** (if any) is JSON-serialized into `_job_runs.output` alongside any `log()` lines. A thrown error sets `status: "failed"` and `error` to the message.

---

## 📁 `_job_runs` Table

```ts
// packages/core/src/jobs/schema.ts
export const JOBS_SCHEMA: DatabaseSchema = {
  _job_runs: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    job_name: { type: "text", nullable: false },
    status: { type: "text", nullable: false },   // "running" | "success" | "failed"
    started_at: { type: "text", nullable: false, default: "CURRENT_TIMESTAMP" },
    ended_at: { type: "text" },
    duration_ms: { type: "integer" },
    output: { type: "text" },                     // log() lines + serialized return
    error: { type: "text" },                      // failure message
  },
};
```

Index on `(job_name, started_at DESC)` for the history/`logs` query (created idempotently on scheduler start, mirroring how `StorageEngine` provisions indexes outside the migration system). The table is **already registered** in `packages/core/src/admin/system-tables.ts`, so the generic admin row-CRUD API already refuses to write to it.

---

## 🚀 Build Sequence (milestones)

Each milestone is independently shippable and verifiable. Tests use **Node's built-in `node:test`** (the repo standard — no vitest), colocated next to source as `*.test.ts`.

### ✅ M1 — Schema, config types, validation (no runtime)
**Goal:** the data model and config contract exist and are validated at startup; nothing runs yet.

**Files:**
- `packages/shared/src/index.ts` — add `JobConfig`; add `jobs?: Record<string, JobConfig>` to `LocalBaseConfig`.
- `packages/core/src/jobs/schema.ts` — `JOBS_SCHEMA` (`_job_runs` as above).
- `packages/core/src/db.ts` — conditionally merge `JOBS_SCHEMA` into `effectiveSchema` when `jobs` config is present (mirror the `STORAGE_SCHEMA` merge). Note: constructor takes `jobs?: Record<string, JobConfig>` in `DatabaseOptions`, or read from a resolved config — follow whichever the storage/auth pattern dictates for minimal surface.
- `packages/cli/src/config.ts` — add `validateJobs(config)`: each entry must have a non-empty `schedule` (parse with `croner` to reject invalid expressions), a non-empty `handler` string, optional `timezone`/`enabled`/`description`; call it from `loadConfig` next to `validateStorage`/`validateBuckets`/`validatePolicies`.

**Tasks:**
- [x] Add `JobConfig` type + `jobs?` field to `LocalBaseConfig` in shared; re-export from `packages/core/src/index.ts` shared block.
- [x] Create `packages/core/src/jobs/schema.ts` exporting `JOBS_SCHEMA`.
- [x] Merge `JOBS_SCHEMA` into `effectiveSchema` in the `Database` constructor (conditional on jobs config).
- [x] Add `validateJobs` to the CLI config loader (validates cron syntax via `croner`, rejects duplicate names, requires `handler` string).
- [x] Write tests: `_job_runs` exists after migrate when jobs configured; bad cron rejected at `loadConfig`; duplicate/missing handler path rejected.

**Done when:** a config with a `jobs` map loads; a malformed schedule/handler fails at `localbase dev` startup with an actionable `ConfigError`; `_job_runs` is present in the DB.

### ✅ M2 — Job runner (load, execute, log)
**Goal:** a single job can be invoked by name, its handler loaded and run, and the outcome recorded in `_job_runs`.

**Files:**
- `packages/core/package.json` — add `jiti` and `croner` deps.
- `packages/core/src/jobs/types.ts` — `JobContext`, `JobHandler`.
- `packages/core/src/jobs/runner.ts` — `JobRunner`: holds `{ db, cwd, jobs }`; `run(name)` inserts a `running` row, builds a per-run `log()` buffer, imports the handler via `createJiti(cwd, { interopDefault: true }).import(path)` (same pattern as the config loader), validates the export is a function, calls it with `{ db, log, name }`, then updates the row to `success`/`failed` with `ended_at`, `duration_ms`, `output`, `error`.
- `packages/core/src/jobs/index.ts` — barrel exporting `JOBS_SCHEMA`, `JobRunner`, types.

**Tasks:**
- [x] Add `jiti` + `croner` to `packages/core` dependencies.
- [x] Implement `JobRunner.run(name)` with full `_job_runs` lifecycle (running → success/failed).
- [x] Concurrency guard: maintain an in-memory `Set<string>` of running names; reject re-entry with a `skipped` note (return early, do not insert a `running` row).
- [x] Validate handler export shape; emit a clear error into `error` if the default export is not a function.
- [x] Write runner tests (in-memory DB): success path records `output`; thrown error records `status: "failed"` + message; non-function export records error; re-entry while running is skipped.

**Done when:** `runner.run("foo")` loads `./jobs/foo.ts`, executes the default export, and `_job_runs` contains one completed row reflecting the outcome.

### ✅ M3 — Scheduler (cron-driven, process lifecycle)
**Goal:** jobs fire on their cron schedule inside a long-running process.

**Files:**
- `packages/core/src/jobs/scheduler.ts` — `Scheduler` class: constructed with `{ db, cwd, jobs }`; `start()` creates a `croner.Cron` per enabled job whose callback calls `runner.run(name)`; `stop()` destroys all cron instances; `runNow(name)` delegates to the runner (used by CLI + admin manual trigger); `listJobs()` returns `{ name, schedule, timezone, enabled, nextRun, lastRun, lastStatus }` by combining the config map with `_job_runs` queries; `getNextRun(name)`, `getRuns(name, { limit, offset })` helpers for CLI/admin.

**Tasks:**
- [x] Implement `Scheduler.start()` / `.stop()` over `croner.Cron` instances.
- [x] Implement `runNow(name)` (manual trigger path) — same concurrency guard as the runner.
- [x] Implement `listJobs()` / `getNextRun(name)` / `getRuns(name, opts)` readers.
- [x] **No backfill:** on `start()`, schedule the next *future* run only (croner default); never replay missed runs.
- [x] Write scheduler tests: a sub-minute/fake-clock schedule fires and writes a row; `stop()` cancels future firings; `runNow` triggers immediately; an overlapping firing is skipped.

**Done when:** a registered job with a short schedule produces `_job_runs` rows on its own, and `stop()` halts it.

### ✅ M4 — CLI commands + dev integration
**Goal:** developers inspect and trigger jobs from the terminal; the scheduler starts with `localbase dev`.

**Files:**
- `packages/cli/src/jobs.ts` — `listJobsCommand`, `runJobCommand`, `jobLogsCommand`. Local `openDb()` helper mirroring `auth.ts`/`admin.ts` (`loadConfig` → `new Database(...)` → return `{ db, jobs }`).
- `packages/cli/src/index.ts` — wire `localbase jobs list | run <name> | logs <name>` subcommand group (mirror the `auth`/`admin` groups).
- `packages/cli/src/dev.ts` — construct `Scheduler` after the HTTP server is up (next to `createRealtimeServer`); hold it in a module-level `currentScheduler`; call `.stop()` in `stop()` and on config hot-reload teardown.

**Tasks:**
- [x] Implement `localbase jobs list` (name, schedule, enabled, next run, last run + status).
- [x] Implement `localbase jobs run <name>` (manual trigger via `scheduler.runNow`, prints the resulting run id/status).
- [x] Implement `localbase jobs logs <name>` (last N runs from `_job_runs`, newest first).
- [x] Integrate `Scheduler` into `dev.ts` lifecycle (start on boot, stop on teardown + hot-reload, no-op when `config.jobs` is empty).
- [x] Write CLI tests: `jobs list` output shape against a fixture config; `jobs run` writes a `_job_runs` row; `jobs logs` renders history.

**Done when:** `localbase jobs list` shows next/last run; `localbase jobs run foo` triggers immediately; `localbase dev` runs registered jobs on schedule.

### M5 — Admin run viewer + README
**Goal:** the dashboard's reserved Jobs viewer goes live; docs are current.

**Files:**
- `packages/core/src/admin/router.ts` — add `GET /_api/admin/jobs`, `GET /_api/admin/jobs/:name/runs`, `POST /_api/admin/jobs/:name/run`. The router already receives the scheduler context (or construct a read-only view from `_job_runs` + the config map); thread it in alongside the existing `db`/`auth` args. Inherits `requireAdmin`.
- `packages/admin/src/App.tsx` + new `packages/admin/src/views/Jobs.tsx` — flip the gated Jobs nav item on; list jobs, trigger a run, view run history (TanStack Query against `/_api/admin/jobs/*`, invalidate on manual trigger).
- `README.md` — new `## Scheduled Jobs` quickstart section (mirror the Auth/Storage sections); fix the stale roadmap line that mis-numbers the phases.

**Tasks:**
- [ ] Add the three admin endpoints (read + trigger), gated by `requireAdmin`, returning `{ data } | { error }`.
- [ ] Validate `:name` against the job registry (404 on unknown; never a path lookup on the trigger endpoint).
- [ ] Enable the Jobs viewer in the admin SPA: job list (with next/last run + status), run-now button, paginated run history with output/error.
- [ ] Verify realtime live-update: a scheduled or manual run updates the viewer without a manual refresh (relies on Phase 8 broadcasting `_job_runs` change events).
- [ ] Write admin endpoint tests: unknown name 404; non-admin 403; manual trigger inserts a run; history pagination.
- [ ] Update README: scheduled-jobs quickstart; correct the phase-numbering roadmap line.

**Done when:** an admin can browse jobs, trigger one, and watch its run appear and complete in the dashboard in realtime.

---

## ⚠️ Risks & Open Questions

1. **Handler import caching.** `jiti` caches modules, so a handler edited after `dev` started won't reload unless the dev process restarts (or hot-reload tears down + restarts the scheduler). Acceptable in dev (config hot-reload already restarts the server); document that handler edits require a restart. A `jiti` cache-bust option is a P1 nicety.
2. **Sub-minute precision / clock skew.** First cut uses real timers (`croner`). Tests must use a fake clock or a short schedule to avoid flakiness; do not sleep for minutes in CI.
3. **Long-running jobs.** A job that runs longer than its interval hits the concurrency skip. Document this and recommend interval > expected runtime; a future `timeout` option (kill after N ms) is P1.
4. **Single-process only.** The scheduler lives in the `dev` process. Running two `localbase dev` instances against the same `.localbase/` would double-fire jobs. Out of scope for first cut (mirrors the realtime single-process stance); a distributed lock ( advisory lock in SQLite ) is a later hardening.
5. **Output size.** A chatty handler could bloat `_job_runs.output`. Cap stored output (e.g. truncate to ~64 KiB) in M2 and note it.
6. **No retries / no backfill.** Explicitly deferred (matches `LOCALBASE-POST-MVP.md` "Job retries" decision point). A failed job stays failed; the row is the record.
7. **`croner` vs `node-cron` confirmation.** Decision #1 proposes `croner`. Confirm the API surface (`Cron`, `.nextRun()`, timezone option) still matches before M3.

---

## 🚫 Out of Scope (this plan)

- Job **retries / backoff** — log only; defer (matches post-MVP decision point).
- **Backfilling** missed runs after downtime — never replay.
- **Queues / background workers** beyond cron — no ad-hoc job enqueue API. (Developers can write a Node script for one-off work.)
- **Distributed / multi-process scheduling** — single `dev` process only.
- **Edge Functions** — explicitly out for the whole post-MVP effort (`LOCALBASE-POST-MVP.md`).
- **Sub-minute schedules** (seconds precision) — 5-field cron only.
- **Handler timeout / cancellation** — P1 follow-up.
- **SDK namespace** — jobs are server-side; there is no `db.jobs` client API. The only client surface is the admin UI viewer.
- **Editing jobs from the dashboard** — config-first stays the philosophy; the UI is read + trigger only.

---

## 🔗 Dependencies

- **Requires:** MVP (Database + API) ✅.
- **Builds on (already done):** Phase 8 Realtime ✅ — run-status writes broadcast to the dashboard for free; Phase 10 Admin UI ✅ — the Jobs viewer stub and the `requireAdmin` gate already exist; `_job_runs` is already pre-registered in the admin system-table write-gate.
- **Unblocks:** the admin SPA "Jobs viewer" nav item (`packages/admin/src/App.tsx`, currently gated on Phase 11).
- **Reuses:** `jiti` (already a CLI dep, newly added to core) for handler loading — same loader as `localbase.config.ts`.

---

## 📊 First-cut success metric

> A developer adds a `cleanup_sessions` job to `localbase.config.ts`, runs `localbase dev`, and sees it fire on schedule — its run history visible in `localbase jobs logs` and, after opening the admin dashboard, appearing and completing in realtime without a page refresh.
