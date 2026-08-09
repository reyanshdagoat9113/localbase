# LocalBase — Remaining Launch Tasks

> Developer-preview launch only. PostgreSQL and production-backend positioning are **out of scope** here.
>
> Source of truth for product behavior is code + tests + CI. Update this file when a task ships.

---

## Status overview

| # | Task | Gate | Status |
|---|------|------|--------|
| 1 | Fix CI (dependency audit) | CI-P0 | Done |
| 2 | Reconcile documentation | DOCS-P0 | Pending |
| 3 | Version packages for beta | release prep | Pending |
| 4 | Publish npm beta + registry smoke | NPM-P0 | Pending |
| 5 | Run private beta | BETA-P0 | Pending |
| 6 | Prepare launch assets | launch polish | Pending |
| 7 | Explicit go decision | release owner | Pending |

---

## 1. Fix CI (dependency audit)

**Gate:** CI-P0  
**Status:** Done  

**Why it matters**  
The master launch checklist marked CI-P0 complete, but the latest `dev` run is red. CI is a hard release gate: we must not publish or invite beta users from a branch that fails required checks.

**What was done**

- Failing job was `Dependency audit` (`npm audit --omit=dev --audit-level=high`).
- Upgraded production / workspace deps that carried high/moderate advisories:
  - `react-router-dom` → `^7.18.2` (admin; fixes GHSA-qwww-vcr4-c8h2)
  - `hono` → `^4.13.1` (core)
  - `@hono/node-server` → `^2.1.0` (core, cli, sdk test helper)
- Also applied `npm audit fix` for transitive dev tooling (postcss/nanoid/esbuild) so the full tree is clean locally.
- Local verification: `npm audit --omit=dev --audit-level=high` → 0 vulns; `npm audit` → 0 vulns; `npm run build` succeeds.

**Audit triage policy** (unchanged, documented in `.github/workflows/ci.yml`)

- CI fails on **critical/high** in production deps (`--omit=dev --audit-level=high`).
- moderate/low and pure dev-only advisories are non-blocking per PR; track in the periodic dependency-upgrade cycle.
- No audit exceptions currently accepted.

**Done when**

- Latest CI on the candidate branch is fully green with no skipped P0 jobs.
- Any accepted audit exceptions are written down (where and why).

---

## 2. Reconcile documentation

**Gate:** DOCS-P0  
**Status:** Pending  

**Why it matters**  
Feature work (auth, realtime security, storage, admin, jobs, backup) is largely implemented, but several planning docs still describe unfinished work, wrong admin paths, or old E2E behavior. Launch and beta users will follow README / getting-started; internal docs that contradict code confuse maintainers and reviewers.

**What to do**

- Align user-facing docs with real behavior: `README.md`, `docs/GETTING-STARTED.md`, package READMEs, CLI examples (e.g. `npx @localbase/cli` vs `npx localbase`).
- Update or clearly mark as historical:
  - `LOCALBASE-LAUNCH-READINESS.md` (body still says E2E “currently” reuses task-board; production gate lists work that exists for preview)
  - `LAUNCH.md` (“why not launch” still lists finished realtime/network/E2E gates)
  - `LOCALBASE-POST-MVP.md` (Phase 11 Jobs still unchecked; stale `/_/admin` paths)
  - `LOCALBASE-JOBS.md` intro (“jobs not implemented”) vs completed checklists
  - `LOCALBASE.md` (vision/stack drift: Drizzle, Fastify-only, backups/jobs as future)
  - Stale code comments (e.g. `system-tables.ts` still says Storage/Jobs “not yet implemented”)
- Document beta operational limits honestly: SQLite-only, single-process realtime/jobs, local Storage, backup procedure, CORS/TLS/secrets for non-loopback use.
- Ensure security and limitation claims are backed by code or tests.

**Done when**

- A new reader can follow the quickstart from a clean machine without hitting doc lies.
- Plan docs either match reality or are labeled as history / completed phases.
- DOCS-P0 reviewer checklist in launch-readiness is satisfiable.

---

## 3. Version packages for beta

**Gate:** Release prep (feeds NPM-P0)  
**Status:** Pending  

**Why it matters**  
Public packages are currently `0.1.0` while the changelog and release process plan a prerelease line (`0.1.0-beta.N`). Publishing plain `0.1.0` under the wrong tag, or mismatched versions across packages, breaks the controlled beta process.

**What to do**

- Use the repo version tooling (`npm run version:set -- 0.1.0-beta.1` or the next beta number) so `@localbase/shared`, `@localbase/core`, `@localbase/sdk`, and `@localbase/cli` share one version.
- Keep private packages (`admin`, `e2e`, examples, monorepo root) out of the public version line as designed.
- Update `CHANGELOG.md` for the beta entry (move from “pending” to the actual version/date when ready).
- Confirm internal dependency versions between the four public packages remain consistent.

**Done when**

- All four public packages report the same prerelease version.
- Changelog describes that version and known limitations for the developer preview.

---

## 4. Publish npm beta + registry smoke

**Gate:** NPM-P0  
**Status:** Pending  

**Why it matters**  
Workspace installs are not the release artifact. Users must be able to install from the public registry. Packages are not on npm yet (`@localbase/*` 404).

**What to do**

- Confirm npm scope ownership, 2FA / trusted publishing, and the protected publish environment.
- From a clean checkout of a green release commit: build, `pack:smoke`, then publish in dependency order via `npm run publish:prerelease` (or the documented flow) under the **`beta`** dist-tag — not `latest` initially.
- After publish, run a **fresh-directory** install from the registry (not workspace links) and exercise init, migrate/dev, REST, auth, realtime, Storage, Admin Studio, graceful shutdown — same bar as local pack smoke.
- Record commit SHA, package versions, CI run URL, smoke results, and integrity hashes in `docs/RELEASE-CHECKLIST.md`.
- On partial failure: stop, do not tag, roll forward with a new beta version (never overwrite an npm version).

**Done when**

- All four packages install from npm at the published beta version.
- Registry smoke matches local tarball smoke outcomes.
- NPM-P0 evidence is recorded on the release checklist.

---

## 5. Run private beta

**Gate:** BETA-P0  
**Status:** Pending  

**Why it matters**  
Internal green CI and docs are not enough. Launch requires proof that outsiders can install and complete the quickstart without maintainer hand-holding.

**What to do**

- Invite ~5–10 developers who did not implement LocalBase.
- Ask each to: install the npm beta on a supported Node version (`>=22`), complete the documented quickstart, use Admin Studio and the SDK, and exercise auth, realtime, and Storage.
- Collect: install success, time-to-first-API, platform/Node, first confusion, security or data-loss issues — without collecting their application data.
- Fix or explicitly de-scope any repeated blockers before public promotion.

**Done when**

- No unresolved critical/high security issues.
- At least ~80% complete the quickstart without intervention.
- No repeatable install/native-module failure on a claimed platform.
- CI and registry smoke remain green on the candidate commit.

---

## 6. Prepare launch assets

**Gate:** Launch polish (P1 for public promotion; useful during private beta)  
**Status:** Pending  

**Why it matters**  
Clear visuals and a tight story reduce support load and set correct expectations (local SQLite preview, not a Supabase replacement).

**What to do**

- Capture a current Admin Studio screenshot (referenced from README; `docs/admin-ui.png` or equivalent).
- Record a short (15–30s) `init → studio → edit row` clip if promoting publicly.
- Prepare GitHub release notes, FAQ (SQLite, single-process, backups, production suitability, vs PocketBase/Supabase), and issue/feedback links.
- Avoid unsubstantiated claims (“production-ready,” “Supabase replacement,” huge concurrency).

**Done when**

- README (or docs) shows a real Studio screenshot.
- Release notes + FAQ are ready to publish with the tag.
- Messaging matches documented limitations.

---

## 7. Explicit go decision

**Gate:** Release owner approval  
**Status:** Pending  

**Why it matters**  
Publishing tags, promoting `latest`, and public posts are irreversible brand moments. They require a human go/no-go after the engineering and beta gates, not “CI was green once.”

**What to do**

- Confirm gates 1–5 (and assets as needed for the chosen launch stage) are complete with evidence.
- Decide stage: stay on private beta, public developer preview under `beta`, or promote a tested version to `latest`.
- Only then: tag the exact commit, publish GitHub release notes, verify unauthenticated clean-room quickstart, and post launch communications.
- Keep a maintainer available for install/security/data-loss reports for the first 24–48 hours after public promotion.
- Know the rollback path: deprecate bad npm versions, move dist-tags, roll forward — never overwrite published versions.

**Done when**

- A named owner records go or no-go with the release commit and package versions.
- If go: tag, notes, and promotion steps match the staged launch plan in `LAUNCH.md`.

---

## Explicitly not in this list

- **PostgreSQL support** — separate architecture project (driver abstraction, async DB surface, dialect layer, dual CI). Not required for developer-preview launch.
- **Production-backend positioning** — multi-instance ops, load/capacity claims, full DR productization, etc. See production gate in `LOCALBASE-LAUNCH-READINESS.md`.
- **macOS/Windows CI smoke** — optional before claiming broad cross-platform support; Linux Node 22/24 is the current required matrix.

---

## Related docs

- [`LOCALBASE-LAUNCH-READINESS.md`](./LOCALBASE-LAUNCH-READINESS.md) — full gate definitions (may lag code; prefer this file + CI for “what’s left”)
- [`LAUNCH.md`](./LAUNCH.md) — staged launch strategy
- [`docs/RELEASE-CHECKLIST.md`](./docs/RELEASE-CHECKLIST.md) — per-publish checklist
- [`CHANGELOG.md`](./CHANGELOG.md) — version history
