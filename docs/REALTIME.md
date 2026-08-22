# Realtime

WebSocket endpoint, default `ws://127.0.0.1:5180/realtime`. Enabled unless `realtime.enabled` is `false`. Tunables: [CONFIG](./CONFIG.md#realtime).

Mutations that go through `Database` (REST, Studio, Jobs) emit `insert` / `update` / `delete` events. System tables (`_users`, `_sessions`, …) are **not** subscribable.

---

## SDK

The client is **`db.subscribe`**, not `db.from(...).subscribe`.

```ts
const unsub = db.subscribe("posts", (event) => {
  console.log(event.type, event.row, event.cursor);
});

// Equality filters
db.subscribe("posts", { where: { published: 1 } }, handler);

// Full filter list (same operators as REST)
db.subscribe("posts", {
  filters: [{ column: "title", operator: "like", value: "%draft%" }],
}, handler);

unsub();
```

`event` shape: `{ type, table, row, id?, timestamp?, cursor? }`.

### Presence

```ts
const handle = db.presence("room:1", "user-42", { name: "Rey" }, (event) => {
  // event.type: "sync" | "join" | "update" | "leave"
});
handle.update({ name: "Reyansh" });
handle.leave();
```

Disable presence server-side with `realtime.presence: false`.

### Connection behavior

- Token is sent as the **first WebSocket frame** `{ type: "auth", token }`, never in the URL.
- When auth is disabled, the handshake is skipped.
- Transient disconnects reconnect with exponential backoff and resubscribe.
- A bad/expired token at handshake **does not** spin reconnect; handle `onAuthError` and sign in again.
- After reconnect the client sends its last `cursor`. If the server restarted or the replay buffer dropped that position, you get `resync-required` → `onResync`. Refetch REST; live events continue from the new point.

```ts
const db = createClient(url, {
  onAuthError: () => { /* send user to sign-in */ },
  onResync: () => { /* reload lists */ },
});
```

---

## Auth and RLS

When auth is enabled, the socket must authenticate before subscriptions are accepted. Owner policies apply to **delivery and replay**: you only receive rows you would see on `GET /api/:table`. `adminBypass` uses the live role, same as REST.

---

## Limits

Per-socket caps (subscriptions, filters, presence, inbound rate, buffered bytes) are in `realtime.limits`. Hitting them closes the socket as abusive. Defaults are conservative for a single-process preview.
