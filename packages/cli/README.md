# @localbase/cli

Command-line interface for LocalBase: project init, migrations, dev server, Admin Studio, auth, and admin helpers.

## Install

```bash
npm install -g @localbase/cli
# or one-shot without a global install:
npx @localbase/cli init
```

Requires Node.js `>=22`.

The npm package is **`@localbase/cli`**; the binary name is **`localbase`**.
There is no separate package named `localbase` on npm.

## Quickstart

```bash
mkdir my-app && cd my-app
npx @localbase/cli init
npx @localbase/cli studio
# After a global install: localbase studio
```

`init` scaffolds the **current working directory** (creates `localbase.config.ts` and `.localbase/`). There is no `init <directory>` form.

Admin Studio is served at `http://127.0.0.1:5180/admin/` (not `/_/admin`).

## Commands

```
localbase init              Scaffold config + data directory in cwd
localbase dev               Start API server (default http://127.0.0.1:5180)
localbase studio            Dev server + open Admin Studio
localbase db migrate        Apply pending migrations
localbase db reset          Reset user tables (system tables preserved)
localbase db backup [out]   Online backup (SQLite + storage + checksums)
localbase db restore <dir>  Verify and restore a backup (server stopped)
localbase auth create-user  Create a user (auth.enabled required)
localbase admin promote     Grant admin role
localbase jobs list|run|logs  Inspect / trigger scheduled jobs
```

## Developer preview limits

Single-process SQLite runtime (HTTP + realtime + jobs). Local disk Storage.
Manual backups only. Not positioned as a multi-instance production backend.
See the root README “Operational limits” section.

## License

MIT
