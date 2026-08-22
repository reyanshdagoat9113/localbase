# CLI

Package: **`@localbase/cli`**. Binary: **`localbase`**.

```bash
npx @localbase/cli <command>
# after install:
localbase <command>
```

Requires a `localbase.config.ts` in the current working directory (except `init`). `--help` lists commands.

---

## `init`

Scaffold cwd: create `localbase.config.ts` and `.localbase/`. Safe to re-run (does not overwrite an existing config). If `.gitignore` already exists, appends `.localbase/`.

There is **no** `init <path>` form.

---

## `dev` / `studio`

Start the API, realtime server, job scheduler, and Admin Studio.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `5180` | Listen port |
| `-H, --host <addr>` | `127.0.0.1` | Bind address. `0.0.0.0` for LAN |
| `--open` | off (`dev`) | Open Studio in the default browser |
| `--no-open` | — (`studio` only) | Do not open a browser |
| `--admin-unsafe-public` | off | Allow **ungated** admin on a non-loopback bind when auth is disabled |

`studio` is `dev --open` with slightly friendlier output.

When **auth is disabled**, the admin API is ungated. Binding that to a non-loopback host is a **startup error** unless you pass `--admin-unsafe-public`. Anyone who can reach the port then has full admin access.

Config changes hot-reload the server. The browser is opened at most once per invocation.

---

## `db`

| Command | Behavior |
| --- | --- |
| `db migrate` | Apply pending CREATE TABLE / ADD COLUMN migrations and print status |
| `db reset` | Drop **user** tables and re-run migrations. System tables (`_users`, `_sessions`, …) are kept |
| `db backup [out]` | Online backup of SQLite + storage + SHA-256 manifest. Server may stay up. Omit `out` to write `backups/localbase-backup-<timestamp>/` |
| `db restore <dir>` | Verify checksums + integrity, then atomically replace live data. **Stop the server first** |

Backup procedure: [BACKUP-AND-RECOVERY](./BACKUP-AND-RECOVERY.md).

---

## `auth`

Requires `auth.enabled`. Credentials can come from flags or env (`AUTH_EMAIL`, `AUTH_PASSWORD`) so they stay out of shell history.

| Command | Behavior |
| --- | --- |
| `auth create-user` | Create a user (`-e/--email`, `-p/--password`) |
| `auth list-users` | List accounts, oldest first |
| `auth reset-password` | Set a new password for an email |

---

## `admin`

Requires `auth.enabled`. First sign-up is the owner; these commands manage the admin role.

| Command | Behavior |
| --- | --- |
| `admin promote <email>` | Grant admin |
| `admin demote <email>` | Revoke admin. Refuses to demote the owner / last admin. `-f/--force` skips the confirmation prompt |
| `admin list` | List admin users |

---

## `jobs`

Requires a `jobs` map in config.

| Command | Behavior |
| --- | --- |
| `jobs list` | Registered jobs, next/last run, status |
| `jobs run <name>` | Run now and print the outcome |
| `jobs logs <name>` | Recent runs, newest first. `-n/--limit` (default 10) |

---

## Environment

| Variable | Meaning |
| --- | --- |
| `LOCALBASE_DATA_DIR` | Override `.localbase/` (absolute, or relative to cwd) |
| `AUTH_EMAIL` / `AUTH_PASSWORD` | Credentials for `auth create-user` / `reset-password` |
| `JWT_SECRET` | Common pattern: `auth.jwtSecret: process.env.JWT_SECRET` in config |
