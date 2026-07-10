# @localbase/core

LocalBase server runtime: SQLite, generated REST API, auth, realtime, Storage, Jobs, and the embedded Admin Studio.

## Install

```bash
npm install @localbase/core
```

Requires Node.js `>=22`. Native dependencies (`better-sqlite3`, `@node-rs/argon2`) install via prebuilt binaries on supported platforms.

## Usage

Prefer the CLI for local development:

```bash
npx @localbase/cli init
npx localbase dev
```

Programmatic use:

```ts
import { Database, createServer } from "@localbase/core";

const db = new Database({ path: ".localbase/data.db", schema: { /* tables */ } });
const app = createServer(db, schema);
```

## Related packages

- [`@localbase/shared`](https://www.npmjs.com/package/@localbase/shared)
- [`@localbase/sdk`](https://www.npmjs.com/package/@localbase/sdk)
- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli)

## License

MIT
