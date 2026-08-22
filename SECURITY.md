# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x (beta / developer preview) | Yes |
| < 0.1.0 | No |

LocalBase is currently a **developer preview**. Security fixes are applied on the latest beta line only.

## Reporting a vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Please report privately via one of:

1. **GitHub Security Advisories** — [Report a vulnerability](https://github.com/reyanshdagoat9113/localbase/security/advisories/new) on this repository (preferred).
2. **Email** — `reyansh.dharmapurikar@gmail.com` with subject `[SECURITY] LocalBase …`

Include:

- Affected package(s) and version(s)
- Description of the issue and impact
- Steps to reproduce or a proof of concept
- Any suggested fix (optional)

We aim to acknowledge reports within **72 hours** and to provide a status update within **7 days**. Coordinated disclosure is preferred; please allow a reasonable window before public disclosure.

## Scope notes (preview)

The developer preview is intended for local development, prototypes, and internal tools. Known operational limits (single-process realtime/scheduler, local-disk Storage, TLS termination required for non-loopback deployments, etc.) are documented in the repository [README](README.md) and [docs](docs/README.md). Reports that rely on intentionally out-of-scope production multi-tenant assumptions may be accepted as feature work rather than security bugs.
