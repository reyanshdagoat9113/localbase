# @localbase/sdk

TypeScript client for LocalBase: query builder, auth, realtime, and Storage.

Requires Node.js `>=22`.

```bash
npm install @localbase/sdk
```

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");

const { data, error } = await db.from("users").select("*").eq("email", "a@b.com");

await db.auth.signIn({ email: "a@b.com", password: "secret123" });

const unsub = db.subscribe("users", (event) => {
  console.log(event.type, event.row);
});
```

Every data/auth/storage call returns `{ data, error }` (does not throw on HTTP errors). Update and delete must `.eq("id", …)`. Realtime is `db.subscribe`, not `db.from(...).subscribe`.

Full reference: [docs/SDK.md](https://github.com/reyanshdagoat9113/localbase/blob/dev/docs/SDK.md).

## Related

- [`@localbase/cli`](https://www.npmjs.com/package/@localbase/cli)
- [`@localbase/core`](https://www.npmjs.com/package/@localbase/core)

## License

MIT
