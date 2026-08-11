# Release checklist (developer preview)

Use this checklist for each beta publish. npm versions are **immutable** —
never overwrite; roll forward with a new beta version if something is wrong.

## Candidate: `0.1.0-beta.1` — **published**

| Field | Value |
| ----- | ----- |
| Version | `0.1.0-beta.1` |
| Dist-tag | `beta` (also accidentally has `latest` → same version; see notes) |
| Version commit | `45c5f7e48f2f1d2effee85b1fbba79073c9c628a` |
| Publish tooling commit | `844c940` (+ follow-up docs for this release) |
| Local pack smoke | **PASS** |
| Registry publish | **PASS** (2026-08-11, user `reyanshdagoat9113`, no OIDC provenance) |
| Registry smoke | **PASS** (fresh dir install + init/migrate/REST/admin/SDK auth) |
| Provenance | not attached (local publish; enable GHA trusted publishing later) |

### Registry integrity (from `npm view`)

| Package | Version | dist.integrity | dist.shasum |
| ------- | ------- | -------------- | ----------- |
| @localbase/shared | 0.1.0-beta.1 | `sha512-54g5x6LNs3QmdfoJa1Q8+0tcdkA+M/zmJ7afXuiy+cuy/7FVJgjoHxPJXIbQuX96WTs2HyRISTTvqVuUMfQPjw==` | `e8dfaeeb3149be7be7a934726311439c2929ffcb` |
| @localbase/core | 0.1.0-beta.1 | `sha512-nTY949EPey1BLtVnJyJg6zt4QVwXyX/o09fCtlMZVGYrHSggQqoEFAnNAtNJ44ITXXDokrAcLdf1Z9k2J5vOSA==` | `7f153acac78247256658116bfc0dfb93a4ee824a` |
| @localbase/sdk | 0.1.0-beta.1 | `sha512-1jIFmr9S0EHMRMHfUUigpURqMh44QfPxliNiAfCn88V2KntMjCiHyrmQ92RVsenq4HmOyCOwMI5ckJwOMVjGXw==` | `8edbe3b272f7483aad2f141c6d6b386f8399daa0` |
| @localbase/cli | 0.1.0-beta.1 | `sha512-QKdBxVegLvjmFj4FQs6yET3NAbJGmQX5etdz+euxEpQrgD0xNeb3z5VM+iiggElWgpdj1ISl7b6s/rRcrr2bFg==` | `b4ed56df6bc18c2db6f209f014e284cff1047f8a` |

Install for testers:

```bash
npm install @localbase/cli@0.1.0-beta.1
# or: npm install @localbase/cli@beta
npx localbase init
npx localbase studio
```

## Pre-publish

- [x] Release candidate version locked (`version:set`)
- [x] Realtime/auth gates previously met on `dev` (RT-P0, NET-P0)
- [x] `CHANGELOG.md` updated for this version
- [x] `npm run pack:smoke` green (PACK-P0, local tarballs)
- [x] npm scope ownership + 2FA / granular publish token confirmed
- [ ] Publishing environment requires approval; trusted publishing (OIDC) still optional follow-up

## Publish

Script: `npm run publish:prerelease -- --execute`  
Order: shared → core → sdk → cli. Dist-tag: `beta`.  
Provenance only on GitHub Actions (or `--provenance`); local execute skips it.

## Post-publish (NPM-P0)

- [x] Registry metadata correct (`npm view @localbase/cli@0.1.0-beta.1`)
- [ ] Provenance visible when trusted publishing was used (N/A this publish)
- [x] Fresh-directory install from registry smoke **PASS**
- [x] Record: package versions + integrities (above)

### Known follow-ups

1. Remove accidental `latest` dist-tag (currently equals `0.1.0-beta.1`) when token permissions allow, or leave until promotion decision. Prefer documenting `@beta` installs.
2. Packument root document lagged ~2–3 minutes after successful PUT; installs failed until then.
3. Wire GitHub Actions trusted publishing for provenance on future betas.

## Rollback

- Deprecate the bad version: `npm deprecate @localbase/<pkg>@<ver> "reason"`
- Move `beta` dist-tag to the last good version if needed
- Publish a fixed `0.1.0-beta.N+1`
- Do **not** unpublish except under npm’s limited security policy

## Promote to `latest`

Only after private-beta gate (BETA-P0) and explicit owner approval.
