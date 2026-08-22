# @localbase/shared

Shared types, schema helpers, and constants used by LocalBase packages (`LocalBaseConfig`, column types, auth/storage/jobs/realtime config).

Requires Node.js `>=22`. App code usually depends on `@localbase/sdk` or `@localbase/cli` instead of this package directly.

```bash
npm install @localbase/shared
```

```ts
import type { LocalBaseConfig } from "@localbase/shared";

const config: LocalBaseConfig = {
  tables: {
    users: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
};
```

Config reference: [docs/CONFIG.md](https://github.com/reyanshdagoat9113/localbase/blob/dev/docs/CONFIG.md).

## Related

- [`@localbase/core`](https://www.npmjs.com/package/@localbase/core)
- [`@localbase/sdk`](https://www.npmjs.com/package/@localbase/sdk)
- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli)

## License

MIT
