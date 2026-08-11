# Release checklist (developer preview)

Use this checklist for each beta publish. npm versions are **immutable** —
never overwrite; roll forward with a new beta version if something is wrong.

## Candidate: `0.1.0-beta.1`

| Field | Value |
| ----- | ----- |
| Version | `0.1.0-beta.1` |
| Dist-tag | `beta` (not `latest`) |
| Commit SHA | `45c5f7e48f2f1d2effee85b1fbba79073c9c628a` |
| CI run | *(fill when CI green on that commit)* |
| Local pack smoke | **PASS** (`npm run pack:smoke`, 2026-08-11) |
| Registry publish | **blocked** — `ENEEDAUTH` (no npm login / token) |
| Registry smoke | pending publish |

### Local dry-run tarball fingerprints (pre-publish)

| Package | Version | shasum (from `npm publish --dry-run`) |
| ------- | ------- | ------------------------------------- |
| @localbase/shared | 0.1.0-beta.1 | `e8dfaeeb3149be7be7a934726311439c2929ffcb` |
| @localbase/core | 0.1.0-beta.1 | `7f153acac78247256658116bfc0dfb93a4ee824a` |
| @localbase/sdk | 0.1.0-beta.1 | `8edbe3b272f7483aad2f141c6d6b386f8399daa0` |
| @localbase/cli | 0.1.0-beta.1 | `b4ed56df6bc18c2db6f209f014e284cff1047f8a` |

After a real publish, prefer `npm view <pkg>@0.1.0-beta.1 dist.integrity` for the registry integrity hashes.

## Pre-publish

- [ ] Release commit is green in required CI (CI-P0)
- [x] Realtime/auth gates still green on this commit (RT-P0, NET-P0) — previously met on `dev`
- [x] `npm run version:set -- 0.1.0-beta.1` applied to all four public packages
- [x] `CHANGELOG.md` updated for this version
- [x] `npm run pack:smoke` green (PACK-P0, local tarballs)
- [ ] npm scope ownership + 2FA / trusted publishing confirmed
- [ ] Publishing environment requires approval; no long-lived publish token in repo secrets if trusted publishing is available

## Publish

Run the publish command from the protected GitHub Actions environment configured
for npm trusted publishing when available. The script requests npm **provenance
only on GitHub Actions** (or with `--provenance`); local `--execute` skips it
because OIDC is unavailable. It aborts before publishing if any of the four
immutable versions already exists.

**Local publish auth (2026 npm policy):** browser `npm login` alone is not
enough. Either enable account 2FA and pass OTP, or create a **granular access
token** with package write + “Bypass 2FA” and put it in `~/.npmrc` /
`NPM_TOKEN`. Org owner of `@localbase` is required.

```bash
# From a clean checkout of the release commit:
npm ci
npm run build
npm run pack:smoke
npm run publish:prerelease -- --execute   # dist-tag: beta; no local provenance
# On GHA trusted publishing: provenance is automatic
```

Publish order (enforced by the script): shared → core → sdk → cli.

On partial failure: stop. Record which versions exist. Fix and publish a **new**
version number. Do not create a Git tag until all four packages install cleanly.

## Post-publish (NPM-P0)

- [ ] Registry metadata correct (`npm view @localbase/cli@0.1.0-beta.1`)
- [ ] Provenance visible when trusted publishing was used
- [ ] Fresh-directory install from registry:

```bash
mkdir /tmp/lb-registry-smoke && cd /tmp/lb-registry-smoke
npm init -y
npm install @localbase/cli@0.1.0-beta.1
npx localbase init   # binary from the installed @localbase/cli package
# (equivalent: npx @localbase/cli init)
# exercise quickstart / or adapt scripts/pack-smoke for registry mode
```

- [ ] Same smoke outcomes as local tarballs
- [ ] Record: release commit SHA, tag (after checks), package versions, CI run URL, smoke log path, tarball checksums

## Checksums (fill in after publish)

| Package | Version | npm integrity / shasum |
| ------- | ------- | ---------------------- |
| @localbase/shared | 0.1.0-beta.1 | |
| @localbase/core | 0.1.0-beta.1 | |
| @localbase/sdk | 0.1.0-beta.1 | |
| @localbase/cli | 0.1.0-beta.1 | |

- Commit SHA:
- CI run:
- Smoke log:

## Rollback

- Deprecate the bad version: `npm deprecate @localbase/<pkg>@<ver> "reason"`
- Move `beta` dist-tag to the last good version if needed
- Publish a fixed `0.1.0-beta.N+1`
- Do **not** unpublish except under npm’s limited security policy

## Promote to `latest`

Only after private-beta gate (BETA-P0) and explicit owner approval.
