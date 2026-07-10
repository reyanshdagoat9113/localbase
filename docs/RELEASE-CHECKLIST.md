# Release checklist (developer preview)

Use this checklist for each beta publish. npm versions are **immutable** —
never overwrite; roll forward with a new beta version if something is wrong.

## Pre-publish

- [ ] Release commit is green in required CI (CI-P0)
- [ ] Realtime/auth gates still green on this commit (RT-P0, NET-P0)
- [ ] `npm run version:set -- 0.1.0-beta.N` applied to all four public packages
- [ ] `CHANGELOG.md` updated for this version
- [ ] `npm run pack:smoke` green (PACK-P0, local tarballs)
- [ ] npm scope ownership + 2FA / trusted publishing confirmed
- [ ] Publishing environment requires approval; no long-lived publish token in repo secrets if trusted publishing is available

## Publish

Run the publish command from the protected GitHub Actions environment configured
for npm trusted publishing. The script always requests npm provenance and aborts
before publishing if any of the four immutable versions already exists.

```bash
# From a clean checkout of the release commit in the approved publish environment:
npm ci
npm run build
npm run pack:smoke
npm run publish:prerelease -- --execute   # dist-tag: beta
```

Publish order (enforced by the script): shared → core → sdk → cli.

On partial failure: stop. Record which versions exist. Fix and publish a **new**
version number. Do not create a Git tag until all four packages install cleanly.

## Post-publish (NPM-P0)

- [ ] Registry metadata correct (`npm view @localbase/cli@0.1.0-beta.N`)
- [ ] Provenance visible when trusted publishing was used
- [ ] Fresh-directory install from registry:

```bash
mkdir /tmp/lb-registry-smoke && cd /tmp/lb-registry-smoke
npm init -y
npm install @localbase/cli@0.1.0-beta.N
npx localbase init
# exercise quickstart / or adapt scripts/pack-smoke for registry mode
```

- [ ] Same smoke outcomes as local tarballs
- [ ] Record: release commit SHA, tag (after checks), package versions, CI run URL, smoke log path, tarball checksums

## Checksums (fill in)

| Package | Version | npm integrity / shasum |
| ------- | ------- | ---------------------- |
| @localbase/shared | | |
| @localbase/core | | |
| @localbase/sdk | | |
| @localbase/cli | | |

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
