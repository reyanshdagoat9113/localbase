# @localbase/cli

Command-line interface for LocalBase: project init, migrations, dev server, Admin Studio, auth, and admin helpers.

## Install

```bash
npm install -g @localbase/cli
# or
npx @localbase/cli init
```

Requires Node.js `>=22`.

## Quickstart

```bash
mkdir my-app && cd my-app
npx @localbase/cli init
localbase studio
```

`init` scaffolds the **current working directory** (creates `localbase.config.ts` and `.localbase/`). There is no `init <directory>` form.

## Commands

```
localbase init              Scaffold config + data directory in cwd
localbase dev               Start API server (default http://127.0.0.1:5180)
localbase studio            Dev server + open Admin Studio
localbase db migrate        Apply pending migrations
localbase db reset          Reset database
localbase auth create-user  Create a user (auth.enabled required)
localbase admin promote     Grant admin role
```

## License

MIT
