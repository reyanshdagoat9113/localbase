# @localbase/sdk

TypeScript client for LocalBase: Supabase-style query builder, auth, realtime subscriptions, and Storage.

## Install

```bash
npm install @localbase/sdk
```

Requires Node.js `>=22`.

## Usage

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

const { data, error } = await db.from("users").select().eq("email", "a@b.com");
```

With auth:

```ts
await db.auth.signUp({ email: "a@b.com", password: "secret123" });
await db.auth.signIn({ email: "a@b.com", password: "secret123" });
```

## Related packages

- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli) — scaffold and run LocalBase
- [`@localbase/core`](https://www.npmjs.com/package/@localbase/core) — server runtime

## License

MIT
