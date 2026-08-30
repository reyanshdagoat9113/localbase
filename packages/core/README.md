# @localbase/core

LocalBase server runtime: SQLite, generated REST API, auth, realtime, Storage, Jobs, backups, and the embedded Admin Studio.

Requires Node.js `>=22`. Native addons (`better-sqlite3`, `@node-rs/argon2`) install from prebuilds on supported platforms.

## Install

```bash
npm install @localbase/core
```

Prefer the CLI for local development:

```bash
npx @localbase/cli init
npx @localbase/cli studio
```

Programmatic use:

```ts
import { Database, createServer } from "@localbase/core";

const schema = { /* tables */ };
const db = new Database({ path: ".localbase/data.db", schema });
const app = createServer(db, schema, { admin: { enabled: true } });
```

`createServer` enables auth by default. Pass a stable `auth.jwtSecret` for
persistent sessions, or set `auth: { enabled: false }` to opt out explicitly.

The CLI also starts the WebSocket realtime server and job scheduler. Embedding those yourself is documented in [docs/CORE.md](https://github.com/reyanshdagoat9113/localbase/blob/dev/docs/CORE.md).

## Related

- [`@localbase/shared`](https://www.npmjs.com/package/@localbase/shared)
- [`@localbase/sdk`](https://www.npmjs.com/package/@localbase/sdk)
- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli)

## License

MIT
