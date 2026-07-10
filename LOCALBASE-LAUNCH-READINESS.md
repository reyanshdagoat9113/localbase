# LocalBase Launch-Readiness Plan

> Target: a safe, reproducible **developer-preview/public-beta** launch. This
> plan does not authorize production-backend positioning or publication by
> itself. Publishing, tagging, pushing, and community posts remain explicit
> release actions.

## Launch decision

LocalBase may launch as a developer preview only after every P0 gate in this
document is green from a clean checkout and from the actual npm registry.
Production-backend positioning remains out of scope until the production gate
near the end of this document is separately completed.

## Principles

- Secure behavior must match the public documentation across REST, realtime,
  Storage, Jobs, and Admin Studio.
- A release is built from a clean checkout, not from untracked or previously
  generated local state.
- Published tarballs, not workspace imports, are the release artifact under
  test.
- Documentation describes current behavior and limitations; planning history
  must not contradict it.
- Every launch gate has an owner, evidence, and rollback condition.

## Execution order and pull-request boundaries

Use small, independently reviewable PRs. Do not mix the realtime security
contract with release metadata or documentation cleanup.

| Order | PR/work item | Depends on | Completion evidence |
|---|---|---|---|
| 1 | E2E fixture isolation | none | browser suite passes twice |
| 2 | Realtime security contract tests | none | failing security tests demonstrate the current gap |
| 3 | Realtime auth/RLS implementation | item 2 | RT-P0 green |
| 4 | CORS/rate-limit configuration | none; coordinate shared config types with item 3 | NET-P0 green |
| 5 | Node matrix and CI | item 1 | CI-P0 green on all supported runtimes |
| 6 | Legal/community and package metadata | runtime range selected in item 5 | LEGAL-P0 and dry-run packs green |
| 7 | Tarball smoke-test automation | items 3–6 | PACK-P0 green |
| 8 | Documentation reconciliation | behavior frozen by items 3–7 | DOCS-P0 green |
| 9 | npm beta publication | all preceding P0 gates | NPM-P0 green |
| 10 | Private beta | npm beta available | BETA-P0 green |
| 11 | Public developer-preview release | explicit owner approval | recorded release checklist |

Suggested ownership can be parallelized after contracts are locked:

- Security owner: items 2–4.
- Quality owner: items 1 and 5.
- Release owner: items 6, 7, 9, and 11.
- Documentation/community owner: items 8 and 10.

Any PR changing public behavior must update tests and the relevant current-user
documentation in the same PR. Historical planning checklists may be reconciled
in item 8.

## Workstream 1 — Realtime authorization and network security (P0)

### 1.1 Lock the realtime security contract

Choose and record one contract before implementation:

1. When auth is enabled, the WebSocket handshake authenticates a valid access
   token and rejects missing, invalid, or expired credentials.
2. Subscriptions to a table with an owner policy apply the same owner scope as
   REST reads; admins bypass only when `adminBypass` is enabled and their live
   database role still permits it.
3. Tables without a policy retain the documented public behavior. System tables
   remain unsubscribable in every mode.
4. Event replay applies authorization before sending buffered events. Presence
   must not become a channel for impersonation or arbitrary sensitive metadata.
5. Tokens should not be placed in URLs where proxies, histories, and logs may
   retain them. Prefer an initial authentication message or a negotiated
   subprotocol, with a bounded authentication timeout.
6. Until the complete contract is implemented, configurations combining
   realtime with protected policies must fail startup or disable realtime with
   an explicit error; silently running an unprotected socket is unacceptable.

Primary files:

- `packages/core/src/realtime/server.ts`
- `packages/core/src/realtime/subscription-manager.ts`
- `packages/core/src/realtime/filter.ts`
- `packages/sdk/src/realtime.ts`
- `packages/core/src/api.ts`
- `packages/core/src/rls.ts`
- `packages/shared/src/index.ts`

Acceptance criteria:

- Anonymous clients cannot subscribe to protected tables.
- Users receive only events for rows they own, including replayed events.
- Forged filters cannot broaden the server-enforced owner constraint.
- Demoted admins lose bypass privileges without waiting for JWT expiry.
- Expired/revoked credentials close or de-authorize the connection according to
  the recorded contract.
- Existing unauthenticated local-development behavior remains covered by tests
  when auth is disabled.
- Reconnect uses the current refreshed token and surfaces authorization failure
  to the application.

### 1.2 Add security regression tests

Add core and SDK integration tests for handshake success/failure, cross-user
isolation, insert/update/delete visibility, replay isolation, system-table
denial, admin bypass, demotion, reconnect, and presence validation.

Replace the ambiguous process-global replay cursor with an epoch-aware or
opaque cursor. When the requested event has fallen out of the bounded buffer or
the server restarted, send an explicit resync-required event instead of
silently returning an incomplete history.

Presence identities must be derived from the authenticated principal or a
server-issued connection identifier. Bound channel/key lengths, metadata size,
joined channels per socket, filters, subscriptions, message rate, payload size,
and replay work. Add ping/pong idle cleanup and backpressure handling.

Gate RT-P0: all realtime security tests pass and no protected row can be
observed by another user through live events or replay.

### 1.3 Harden HTTP exposure defaults

- Replace unrestricted `cors()` with configurable allowed origins, methods,
  and headers. Retain an explicit development-friendly default only for
  loopback use.
- Add rate limits for sign-up, sign-in, refresh, admin-account requests,
  password operations, signed-URL creation, and other abuse-sensitive routes.
- Document that TLS termination is required for non-loopback deployments.
- Add request/body limits and consistent security headers where relevant.

Gate NET-P0: an integration suite proves origin denial, rate-limit behavior,
safe loopback defaults, and unchanged CLI public-binding protections.

### 1.4 Define backup and recovery behavior

This is required before production positioning and should be designed during
the preview so users do not invent unsafe copy procedures.

- Define whether a backup includes only SQLite or an atomic-enough snapshot of
  SQLite plus `.localbase/storage`, with a manifest and checksums.
- Add a backup operation using the SQLite backup API and a restore operation
  that verifies integrity before an atomic replacement while the server is
  stopped.
- Record and test the intended `journal_mode`, `synchronous`, `busy_timeout`,
  checkpoint, disk-full, and crash-recovery behavior.
- Add backup → mutate → restore, interrupted restore, corrupt backup, and
  database/storage consistency tests.
- Document realistic RPO/RTO and the absence of automatic remote/encrypted
  backups unless those capabilities are implemented.

## Workstream 2 — Deterministic tests and CI (P0)

### 2.1 Isolate Playwright state

The E2E suite currently reuses `examples/task-board/.localbase`, so accumulated
rows can move newly-created records beyond the first grid page. Replace this
with an ephemeral copied fixture or a unique temporary LocalBase data directory
for every suite run. Never mutate the checked-in example's persistent state.

Primary files:

- `packages/e2e/playwright.config.ts`
- `packages/e2e/global-setup.ts`
- `packages/e2e/lib/env.ts`
- `packages/e2e/lib/seed.ts`
- `packages/e2e/tests/row-editing.spec.ts`

Required behavior:

- Global setup creates a known database from scratch.
- Global teardown removes only its own temporary fixture.
- Tests either clean up their records or use API queries/navigation that do not
  assume a row appears on page one.
- `reuseExistingServer` cannot silently attach to a server backed by unrelated
  state during release validation.
- Two consecutive E2E runs pass without manual cleanup.

Gate E2E-P0: run the suite twice sequentially from a clean checkout; both runs
must report the then-current total in full (18/18 at the time of writing) with
zero retries needed locally.

### 2.2 Establish the supported runtime matrix

- Select supported Node LTS versions after verifying native
  `better-sqlite3`/Argon2 binaries and Commander requirements.
- Add `engines.node` consistently to publishable packages and a root runtime
  pin for contributors.
- Test the minimum and current LTS versions in CI on Linux. Add macOS and
  Windows smoke jobs before declaring broad cross-platform support.

**Resolved (2026-07):** the supported range is `node >=22`. As of July 2026 the
active LTS lines are Node 22 (maintenance LTS) and Node 24 (active LTS); Node 20
is EOL. Both ship prebuilt `better-sqlite3` and `@node-rs/argon2` binaries.
`engines.node: ">=22"` is set on `shared`, `core`, `sdk`, `cli`, and the root
package; `.nvmrc` pins `22` for contributors. The CI matrix (Workstream 2.3)
exercises Node 22 and 24 on Linux. macOS and Windows smoke jobs remain a
follow-up before claiming broad cross-platform support.

### 2.3 Add required CI checks

Create pull-request and main-branch workflows that run:

1. `npm ci`
2. clean workspace build/typecheck
3. core, CLI, and SDK tests
4. Playwright browser installation and E2E tests
5. admin bundle verification
6. package/tarball smoke tests
7. dependency/security audit with a documented triage policy

Use concurrency cancellation, minimal token permissions, action SHA/version
pinning, dependency caching keyed by `package-lock.json`, artifact retention for
Playwright traces, and branch protection requiring all P0 checks.

Gate CI-P0: the exact release commit is green in required CI with no skipped or
manually ignored P0 jobs.

## Workstream 3 — Package and release engineering (P0)

### 3.1 Complete package metadata

For `shared`, `core`, `sdk`, and `cli`, add and verify:

- `description`, `license`, `repository`, `homepage`, `bugs`, `keywords`
- supported `engines.node`
- `publishConfig: { "access": "public" }`
- consistent version and exact internal dependency versions
- README/license inclusion in every tarball

Keep `admin`, `e2e`, examples, and the monorepo root private.

### 3.2 Add legal and contributor files

Create:

- `LICENSE` with the intended MIT grant and correct copyright holder/year
- `SECURITY.md` with supported versions and a private reporting path
- `CONTRIBUTING.md` with setup, tests, changes, and review expectations
- `CHANGELOG.md` with the initial beta release and known limitations
- `CODE_OF_CONDUCT.md` if accepting community contributions
- GitHub bug, feature, and feedback issue forms plus a PR template

Gate LEGAL-P0: the chosen license is approved by the project owner and appears
in the repository and all publishable tarballs.

### 3.3 Test the real publication units

Build all packages, create actual tarballs into a temporary directory, and
install them into a new project without workspace links. Test in dependency
order:

1. `@localbase/shared`
2. `@localbase/core`
3. `@localbase/sdk`
4. `@localbase/cli`

The smoke test must verify ESM and CommonJS imports, TypeScript declarations,
CLI executable permissions, native dependency installation, embedded Admin
Studio assets, `localbase init`, migration, server startup, REST CRUD, auth,
realtime, Storage, and graceful shutdown.

Scaffold contract (resolved): `localbase init` scaffolds the **current
working directory only**. There is no `init <directory>` form; docs and the
pack smoke suite assert cwd-only behavior.

Gate PACK-P0: a scripted fresh-directory test passes using only tarballs, then
passes again using the registry prerelease packages.

### 3.4 Define a controlled prerelease process

- Adopt one fixed-version mechanism for the four public packages. Changesets
  with a fixed/linked group is preferred; a repository-owned atomic version
  script is acceptable. Manual independent version edits are not.
- Confirm ownership of the npm scope and enable npm 2FA/trusted publishing.
- Protect the npm publishing environment with required approval and use
  short-lived trusted-publishing credentials with provenance instead of a
  long-lived repository token.
- Publish `0.1.0-beta.1` under the `beta` dist-tag; do not initially use
  `latest`.
- Publish immutable packages in dependency order and verify registry metadata,
  provenance, install behavior, and exact README quickstart.
- Record checksums, release commit, tag, package versions, CI run, and smoke-test
  output in a release checklist.
- Roll forward with a new beta version if a package is bad; never attempt to
  overwrite an npm version.
- Promote the tested version to `latest` only after the private-beta gate.

Release automation must publish explicitly in dependency order rather than
using a blind workspace-wide publish. It must stop on partial failure, report
which immutable versions exist, and never create a GitHub tag/release until all
four registry packages pass installation checks.

Gate NPM-P0: the registry-installed beta passes the same smoke suite as local
tarballs.

## Workstream 4 — Documentation and positioning (P0)

### 4.1 Make documentation internally consistent

Audit and reconcile:

- `README.md`
- `docs/GETTING-STARTED.md`
- `LOCALBASE.md`
- `LOCALBASE-MVP.md`
- `LOCALBASE-POST-MVP.md`
- `LOCALBASE-ADMIN-UI.md`
- `LOCALBASE-STORAGE.md`
- `LOCALBASE-JOBS.md`
- `LAUNCH.md`
- `COMPETITION.md`
- example READMEs

Move historical plans into a clearly labelled status/history section or update
their checklists. Eliminate stale claims that auth, realtime, Admin Studio,
Storage, or Jobs are missing. Ensure URLs, CLI names, phase numbers, security
claims, and examples match tested behavior.

### 4.2 State the beta's operational limits

Document prominently:

- developer-preview support level and semver expectations
- SQLite, single-process realtime, and single-process scheduler limitations
- no job backfill/retry/distributed lock
- backup/restore procedure and what is not backed up automatically
- local-disk Storage limitations and signed-URL risks
- configuration required for stable secrets, TLS, CORS, rate limits, and public
  binding
- realtime authorization behavior after Workstream 1
- explicit non-goals and migration/export expectations

Gate DOCS-P0: a reviewer can follow the quickstart from a clean machine and all
security/operations statements are backed by code or tests.

### 4.3 Produce launch assets

- Capture a current Admin Studio screenshot and short terminal-to-browser demo.
- Build a small, repeatable demo script around the task-board example.
- Draft the GitHub release, npm README, launch post, FAQ, competitor answers,
  and support/issue links.
- Avoid claims such as “production-ready,” “thousands of concurrent users,” or
  “Supabase replacement” unless separately substantiated.

## Workstream 5 — Private beta and public launch (P0/P1)

### 5.1 Private beta gate

Recruit 5–10 external users who did not work on the repository. Ask each to:

1. install the npm beta on a supported Node version;
2. complete the quickstart without assistance;
3. use Admin Studio and the SDK;
4. exercise auth, realtime, and Storage;
5. report the first confusing or broken step.

Record install success, time-to-first-API, platform/Node version, failures,
security concerns, and requested features without collecting application data.

Gate BETA-P0:

- no unresolved critical/high security issue;
- at least 80% unassisted quickstart completion;
- no repeatable install or native-module failure on a claimed platform;
- all release-blocking feedback resolved or explicitly removed from scope;
- registry smoke test and CI remain green on the candidate commit.

### 5.2 Public developer-preview launch

Sequence:

1. Freeze the candidate commit and run the release checklist.
2. Promote the verified npm version/dist-tag.
3. Push the signed/annotated Git tag and publish GitHub release notes.
4. Verify links and quickstart from an unauthenticated clean environment.
5. Publish the canonical launch post, then share tailored versions to selected
   communities without cross-post spam.
6. Keep a maintainer available during the first 24–48 hours for install,
   security, and data-loss reports.

Launch rollback/stop conditions:

- package cannot install or start on a supported runtime;
- auth/RLS/realtime isolation failure;
- data corruption or destructive migration;
- exposed admin surface under documented safe defaults;
- critical dependency or supply-chain issue.

Respond by deprecating the affected npm version, removing its dist-tag,
publishing a fixed version, and posting a clear advisory. npm versions are
immutable; rollback means dist-tag/deprecation plus roll-forward.

### 5.3 First 30 days (P1)

- Triage critical/security reports immediately and other issues daily during
  launch week.
- Track install success, quickstart completion reports, issue categories,
  response time, and retention of beta users using privacy-respecting signals.
- Publish patch releases through the same gates.
- Review feedback after two weeks and choose the next roadmap item based on
  repeated evidence rather than launch-day novelty.

## Production-backend gate (not required for developer preview)

Do not market LocalBase as production-ready until a separate production plan
covers and tests at least:

- authenticated/RLS-safe realtime;
- configurable CORS, abuse controls, TLS guidance, and security headers;
- documented, tested backup/restore and disaster recovery;
- migration compatibility and rollback strategy;
- database/storage integrity, disk-full, corruption, and crash recovery tests;
- observability, structured logs, health/readiness endpoints, and alerting;
- secrets management and rotation procedures;
- multi-process constraints or explicit single-instance deployment guarantees;
- load/capacity tests with defensible published limits;
- supported-platform matrix and vulnerability response process.

## Master go/no-go checklist

- [x] RT-P0 — realtime authentication and RLS isolation proven
- [x] NET-P0 — CORS, abuse controls, and exposure defaults proven
- [x] E2E-P0 — deterministic browser suite passes twice
- [x] CI-P0 — required checks green on the release commit
- [x] LEGAL-P0 — license and community/security files complete
- [x] PACK-P0 — clean tarball installation and smoke suite pass (local tarballs; registry re-check at publish)
- [ ] NPM-P0 — registry beta installation and smoke suite pass
- [ ] DOCS-P0 — current, consistent, independently followed documentation
- [ ] BETA-P0 — external private-beta threshold met
- [ ] Release owner records an explicit final go decision
