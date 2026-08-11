# LocalBase — Remaining Launch Tasks

> Developer-preview launch only. PostgreSQL and production-backend positioning are **out of scope** here.
>
> Source of truth for product behavior is code + tests + CI. Update this file when a task ships.

---

## Status overview

| # | Task | Gate | Status |
|---|------|------|--------|
| 1 | Fix CI (dependency audit) | CI-P0 | Done |
| 2 | Reconcile documentation | DOCS-P0 | Done |
| 3 | Version packages for beta | release prep | Done |
| 4 | Publish npm beta + registry smoke | NPM-P0 | Done |
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
**Status:** Done  

**Why it matters**  
Feature work (auth, realtime security, storage, admin, jobs, backup) is implemented, but planning docs that still describe unfinished work, wrong admin paths, or old E2E behavior confuse launch/beta users and maintainers.

**What was done**

- Aligned user-facing docs with shipped behavior:
  - `README.md` — CLI package vs binary, backup commands, **Operational limits** table, plan-doc status
  - `docs/GETTING-STARTED.md` — `npx @localbase/cli`, Studio `/admin/`, auth bootstrap, limits (removed inflated concurrency claims)
  - package READMEs (`cli`, `core`) — install/quickstart consistency
- Historical / completed plan docs:
  - `LOCALBASE-POST-MVP.md` — Phase 11 ✅, admin path `/admin`, historical banner
  - `LOCALBASE-JOBS.md` — intro reflects shipped Jobs; decision record locked
  - `LOCALBASE.md` — historical banner; Hono / no Drizzle; Jobs + manual backups shipped
  - `LAUNCH.md` — remaining gates are docs/npm/beta/go (engineering P0s marked done)
  - `LOCALBASE-LAUNCH-READINESS.md` — E2E isolation marked done; production gate distinguishes preview vs production; DOCS-P0 checked
- Stale comments: `packages/core/src/admin/system-tables.ts` no longer claims Storage/Jobs unimplemented
- Documented beta operational limits (SQLite-only, single-process, local Storage, manual backups, CORS/TLS/secrets)

**Done when**

- [x] A new reader can follow the quickstart from a clean machine without hitting doc lies.
- [x] Plan docs either match reality or are labeled as history / completed phases.
- [x] DOCS-P0 reviewer checklist in launch-readiness is satisfiable.

---

## 3. Version packages for beta

**Gate:** Release prep (feeds NPM-P0)  
**Status:** Done  

**Why it matters**  
Public packages must share one prerelease version (`0.1.0-beta.N`) before registry publish. Publishing plain `0.1.0` under the wrong tag, or mismatched versions, breaks the controlled beta process.

**What was done**

- Ran `npm run version:set -- 0.1.0-beta.1` for `@localbase/shared`, `@localbase/core`, `@localbase/sdk`, `@localbase/cli` (internal pins + package-lock updated).
- Private packages (`admin`, `e2e`, examples, monorepo root) remain off the public version line.
- `CHANGELOG.md` updated for `0.1.0-beta.1` (2026-08-11) with features and known limitations.
- Verified: `npm run build` and `npm run pack:smoke` green at this version; `npm run publish:prerelease` dry-run OK.

**Done when**

- [x] All four public packages report the same prerelease version.
- [x] Changelog describes that version and known limitations for the developer preview.

---

## 4. Publish npm beta + registry smoke

**Gate:** NPM-P0  
**Status:** Done  

**Why it matters**  
Workspace installs are not the release artifact. Users must be able to install from the public registry.

**What was done**

- Published `@localbase/{shared,core,sdk,cli}@0.1.0-beta.1` under dist-tag **`beta`** (dependency order).
- Local provenance skipped (no GHA OIDC); publish used a granular access token with 2FA bypass.
- Packuments lagged ~2–3 minutes after PUT before public `npm view`/`npm install` worked.
- Fresh-directory registry smoke (`/tmp/lb-registry-smoke-*`): install cli+sdk, `init`, migrate, REST CRUD, Admin Studio `/admin/`, SDK select + auth signup — **PASS**.
- Evidence recorded in `docs/RELEASE-CHECKLIST.md`.

**Notes / follow-ups**

- First publish also set dist-tag **`latest` → `0.1.0-beta.1`** (npm default for first version). Token lacked permission to `dist-tag rm latest`; prefer installing `@beta` / exact version until private-beta promotion. Remove `latest` when a full-privilege session allows, or leave until go decision.
- CLI bin is present (`localbase` → `dist/index.js`).

**Done when**

- [x] All four packages install from npm at the published beta version.
- [x] Registry smoke matches local tarball smoke outcomes.
- [x] NPM-P0 evidence is recorded on the release checklist.

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
