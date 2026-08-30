# @localbase/cli

Command-line interface for LocalBase: init, migrations, dev server, Admin Studio, auth, admin roles, Jobs, and backup/restore.

Requires Node.js `>=22`.

The npm package is **`@localbase/cli`**; the binary is **`localbase`**. There is no package named `localbase` on npm.

## Install

```bash
npm install -g @localbase/cli
# or:
npx @localbase/cli init
```

## Quickstart

```bash
mkdir my-app && cd my-app
npx @localbase/cli init
npx @localbase/cli studio
```

`init` scaffolds the **current directory** (`localbase.config.ts` with auth enabled and a random per-project fallback secret, plus `.localbase/`). There is no `init <directory>` form.

Admin Studio: `http://127.0.0.1:5180/admin/`.

## Commands

```
localbase init
localbase dev               # default 127.0.0.1:5180
localbase studio            # dev + open Admin Studio
localbase db migrate | reset | backup [out] | restore <dir>
localbase auth create-user | list-users | reset-password
localbase admin promote | demote | list
localbase jobs list | run | logs
```

Flags, env vars, and bind-safety: [docs/CLI.md](https://github.com/reyanshdagoat9113/localbase/blob/dev/docs/CLI.md).

## Developer preview

Single-process SQLite (HTTP + realtime + Jobs). Local-disk Storage. Manual backups. Not a multi-instance production backend. [Operational limits](https://github.com/reyanshdagoat9113/localbase#operational-limits-developer-preview).

## License

MIT
