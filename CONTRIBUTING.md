# Contributing to LocalBase

Thanks for your interest in LocalBase. This document covers setup, tests, and review expectations for the monorepo.

## Prerequisites

- **Node.js `>=22`** (see `.nvmrc` for the contributor pin; CI also tests Node 24)
- npm (lockfile is `package-lock.json`; use `npm ci`)

## Setup

```bash
git clone https://github.com/reyanshdagoat9113/localbase.git
cd localbase
npm ci
npm run build
```

## Scripts

| Command | Purpose |
| ------- | ------- |
| `npm run build` | Build admin SPA, then all workspaces |
| `npm run test:unit` | Unit/integration tests (shared/core/sdk/cli) |
| `npm run test:e2e` | Playwright browser suite |
| `npm run verify` | Build + typecheck + unit tests + admin-bundle check |
| `npm run pack:smoke` | Pack public packages and run the clean-install smoke suite |
| `npm run version:set -- <version>` | Atomically set version on the four public packages |

## Making changes

1. Branch from `dev` (or `main` if directed).
2. Keep PRs focused — see `LOCALBASE-LAUNCH-READINESS.md` for workstream boundaries.
3. Match existing code style; do not add comments unless they are necessary.
4. Any PR that changes public behavior must update tests and **current-user documentation** in the same PR. User-facing docs live in [`docs/`](docs/README.md); keep the root README as the product home and link out. Do not treat `LOCALBASE-*.md` plan files as the source of truth.
5. Do not commit secrets, local data under `.localbase/`, or generated release tarballs.

## Tests

- Prefer `node:test` + `tsx` for package tests (existing pattern).
- E2E uses Playwright with an ephemeral data directory; never mutate checked-in example state.
- Before requesting review, run at least:

```bash
npm run verify
```

For packaging changes also run:

```bash
npm run pack:smoke
```

## Pull requests

- Use the PR template.
- Describe user-visible impact and how you verified the change.
- Link related issues.
- Maintainers may ask for smaller PRs if security, packaging, and docs are mixed without need.

## Documentation

- Index: [`docs/README.md`](docs/README.md)
- Root [`README.md`](README.md) is the product overview and quickstart, not the full API reference
- Package READMEs stay short and link to `docs/`
- Historical design docs at the repo root stay labeled as history

## Package boundary

Publishable packages: `@localbase/shared`, `@localbase/core`, `@localbase/sdk`, `@localbase/cli`.

Private: `@localbase/admin`, `@localbase/e2e`, monorepo root, examples.

Versions of the four public packages must stay locked together (use `npm run version:set`).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License in this repository.
