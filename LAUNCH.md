# LocalBase Launch Strategy

> Launch target: a **developer preview/public beta** for local development,
> prototypes, and internal tools. LocalBase is not currently positioned as a
> production backend.

## Current state

LocalBase now includes the complete MVP and post-MVP feature set:

- SQLite with schema-driven migrations and generated REST CRUD APIs
- TypeScript SDK and hot reload
- email/password auth, rotating refresh tokens, roles, and owner-scoped policies
- realtime subscriptions and presence over WebSockets (auth/RLS when auth is on)
- local file Storage with private buckets and signed URLs
- Admin Studio for data, users, Storage, and Jobs at `/admin/`
- scheduled TypeScript Jobs with run history
- configurable CORS and rate limits; manual backup/restore
- a task-board example that exercises relational application patterns
- CI, legal/community files, package metadata, and local tarball smoke tests

The product surface is complete enough for external testing. Remaining launch
work is **process and distribution**, not unfinished realtime/network/E2E gates:

1. documentation consistency (DOCS-P0 — see [`TASKS.md`](TASKS.md) task 2),
2. versioning + npm beta publication + registry smoke (NPM-P0),
3. private beta with outside developers (BETA-P0),
4. an explicit go decision and public promotion assets.

Day-to-day remaining checklist: [`TASKS.md`](TASKS.md). Full gate definitions:
[`LOCALBASE-LAUNCH-READINESS.md`](LOCALBASE-LAUNCH-READINESS.md).

## Product position

LocalBase occupies the space between a mock API and a hosted backend platform:

- more structured than JSON Server because it provides SQLite, schemas,
  migrations, auth, Storage, realtime, Jobs, and an SDK;
- more code-first than PocketBase or no-code database tools because the schema
  and Jobs live in TypeScript configuration and source files;
- lighter for local development than a cloud account or multi-service Docker
  stack;
- intentionally narrower than production platforms built around PostgreSQL,
  horizontal scaling, managed backups, and operational guarantees.

The launch message should be direct:

> Define a schema and get a local SQLite backend with a REST API, TypeScript
> SDK, auth, realtime, Storage, scheduled Jobs, and an Admin Studio—without
> Docker or a cloud account.

Do not describe the preview as a production Supabase replacement.

## Why not launch immediately?

The feature roadmap and most engineering P0 gates are complete (RT-P0, NET-P0,
E2E-P0, CI-P0, LEGAL-P0, PACK-P0 for local tarballs). Feature completion is still
not the same as a public release. Remaining gates:

1. ~~**Realtime authorization.**~~ ✅ WS auth + owner policies (incl. replay).
2. ~~**Network hardening.**~~ ✅ Configurable CORS, rate limits, TLS guidance in docs.
3. ~~**Deterministic validation.**~~ ✅ Isolated Playwright fixture (ephemeral data dir).
4. ~~**Release infrastructure (local).**~~ ✅ CI, Node ≥22, metadata, legal files, pack smoke.
5. **Accurate documentation.** Quickstarts and plan docs must match shipped
   behavior and honest preview limits (DOCS-P0).
6. **npm beta + registry smoke.** Packages are not yet the release artifact users
   install from the public registry (NPM-P0).
7. **External validation.** A small private beta must prove outsiders can install
   and complete the quickstart without maintainer assistance (BETA-P0).
8. **Explicit go decision** before tags, `latest` promotion, and public posts.

## Staged launch

### Stage 1 — Close engineering gates

Complete the P0 gates in the launch-readiness plan. The release commit must pass
the build, unit/integration suites, browser suite, Admin bundle verification,
and fresh-tarball consumer tests from a clean checkout.

### Stage 2 — Publish a prerelease

Publish the four public packages as one coherent prerelease set under a
non-default npm dist-tag:

1. `@localbase/shared`
2. `@localbase/core`
3. `@localbase/sdk`
4. `@localbase/cli`

Use a version such as `0.1.0-beta.1`. Install the packages back from the public
registry and run the exact documented quickstart before inviting testers. Do
not promote the packages to `latest` merely because publication succeeded.

### Stage 3 — Private beta

Invite 5–10 developers who were not involved in implementation. Ask them to
install from npm, complete the quickstart without synchronous help, use Admin
Studio and the SDK, and exercise auth, realtime, and Storage.

The beta is successful when:

- no critical/high security or data-loss issue remains;
- at least 80% complete the quickstart without intervention;
- claimed Node/OS combinations install reliably;
- repeated onboarding problems are fixed or removed from the supported scope;
- registry smoke tests and required CI remain green.

### Stage 4 — Public developer preview

After an explicit go decision:

1. freeze and verify the release commit;
2. promote the verified package set to the intended public dist-tag;
3. tag that exact commit and publish GitHub release notes;
4. verify all public links and the unauthenticated clean-room quickstart;
5. publish one canonical launch post, then adapt it for selected communities;
6. keep a maintainer available for installation, security, and data-loss
   reports during the first 24–48 hours.

Suggested channels, used sequentially rather than all at once:

- existing network and beta users;
- GitHub and npm;
- Show HN;
- technically relevant JavaScript, web development, and local-first
  communities;
- a longer walkthrough on a developer blog;
- a short current-product demo on social media.

## Launch assets

Prepare these before public promotion:

- one current Admin Studio screenshot;
- a 15–30 second `init → studio → edit row` recording;
- a repeatable task-board demonstration;
- GitHub release notes and an initial changelog;
- bug, feature, beta-feedback, and private security-reporting paths;
- a concise FAQ covering SQLite, single-process behavior, backups, production
  suitability, and comparisons with PocketBase and Supabase.

## Feedback and measurement

Do not add runtime telemetry for the developer preview. Use explicit beta
feedback, GitHub issues, npm download trends, and repository traffic.

Ask users:

1. What were you trying to build?
2. How long did it take to get the first API response?
3. What was the first confusing or broken step?
4. Which feature did you expect but could not find?
5. Would you use LocalBase again for local development or an internal tool?

Review evidence after two weeks and prioritize repeated problems over raw
feature requests.

## Stop and rollback conditions

Stop promotion immediately for:

- an auth, role, policy, realtime, or Admin authorization bypass;
- data corruption, migration loss, or unsafe restore behavior;
- package installation failure on a supported runtime;
- a missing Admin Studio bundle or broken documented quickstart;
- accidental public exposure under documented safe defaults;
- a critical dependency or supply-chain issue.

npm versions are immutable. Rollback means moving the affected dist-tag to the
last coherent package set, deprecating the bad versions, publishing a fixed
version, and communicating the problem. Never overwrite or silently reuse a
published version.

## Production positioning

Production readiness is a separate milestone. It requires authenticated and
policy-safe realtime, tested backup/restore and crash recovery, explicit
deployment constraints, operational health and observability, secrets rotation,
capacity testing, supported-platform guarantees, and a vulnerability response
process.

Until those requirements are complete, launch LocalBase honestly as a
developer preview: a capable local backend that is ready for real users to test,
not a managed or highly available production platform.
