# TypeScript SDK

```bash
npm install @localbase/sdk
```

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:5180");
```

`createClient` holds session state in a closure. After `signIn` / `signUp`, `from()`, `storage`, and realtime all see the same access token.

Optional second argument:

```ts
const db = createClient("http://localhost:5180", {
  realtime: { path: "/realtime", enabled: true },
  onAuthError: (message) => { /* websocket rejected the token */ },
  onResync: (reason) => { /* refetch REST; live events continue */ },
});
```

`db.close()` drops the WebSocket and in-memory session.

---

## Query builder

```ts
const { data, error } = await db.from("users").select("*");
if (error) console.error(error);
else console.log(data);
```

Methods **do not throw** on HTTP errors. Check `error`.

`select()` currently ignores the column list and always returns full rows. Pass `"*"` for clarity.

```ts
// Insert
await db.from("users").insert({ name: "Reyansh", email: "r@r.com" });

// Update / delete — must use a single `.eq("id", …)` filter (additional filters return an error)
await db.from("users").update({ name: "New Name" }).eq("id", 1);
await db.from("users").delete().eq("id", 1);

// Filters (AND)
await db.from("users")
  .select("*")
  .eq("age", 30)
  .gte("age", 25)
  .lt("age", 60)
  .like("name", "%rey%")
  .in("name", ["Alice", "Bob"]);

// Sort + page
await db.from("users")
  .select("*")
  .order("created_at", { ascending: false })
  .order("name")
  .limit(10)
  .offset(20);

const { data: one } = await db.from("users").select("*").eq("id", 1).single();
```

| Method | Notes |
| --- | --- |
| `.eq .neq .gt .lt .gte .lte` | Comparison |
| `.like(col, pattern)` | SQLite `LIKE`; include `%` / `_` |
| `.in(col, values)` | Array |
| `.order(col, { ascending? })` | Default ascending; call more than once |
| `.limit` / `.offset` | Pagination |
| `.single()` | `limit=1` and unwrap one row |

There are no relational `.select("*, comments(*)")` helpers. Load related rows with extra queries (often `.in("parent_id", ids)`) and join in JS.

---

## Auth, realtime, Storage

```ts
db.auth.signUp / signIn / signOut / getUser / refresh / getSession / setSession
db.subscribe(table, callback)
db.subscribe(table, { where | filters }, callback)
db.presence(channel, key, metadata, callback)
db.storage.from("avatars").upload(file)
```

- [AUTH](./AUTH.md)
- [REALTIME](./REALTIME.md)
- [STORAGE](./STORAGE.md)
