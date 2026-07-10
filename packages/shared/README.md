# @localbase/shared

Shared types, schema helpers, and constants used by LocalBase packages.

## Install

```bash
npm install @localbase/shared
```

Requires Node.js `>=22`.

## Usage

```ts
import type { DatabaseSchema } from "@localbase/shared";

const tables: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};
```

## Related packages

- [`@localbase/core`](https://www.npmjs.com/package/@localbase/core) — server runtime
- [`@localbase/sdk`](https://www.npmjs.com/package/@localbase/sdk) — client SDK
- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli) — CLI

## License

MIT
