# Auth and row-level security

Optional. Off until `auth.enabled` is true. Then LocalBase provisions `_users`, `_sessions`, and `_admin_requests` and mounts `/api/auth/*`.

Config: [CONFIG](./CONFIG.md#auth).

---

## How it works

- **Passwords** — Argon2id, per-user salt. Never stored in plaintext.
- **Access tokens** — JWT HS256, default 1 hour (`accessTokenExpiry`). Verified by signature; no DB lookup on ordinary CRUD.
- **Refresh tokens** — 256-bit random hex in `_sessions`, default 30 days. Rotated on every refresh; the old token is invalidated immediately.
- **Roles** — `owner`, `admin`, `user`. The JWT `role` claim is a snapshot. Admin gates and `adminBypass` **re-read `_users.role`** on each request, so a demotion takes effect on the next call.
- **System tables** survive `localbase db reset`.

If `jwtSecret` is omitted, a random one is generated at startup. Restarts then invalidate every session. Set a stable secret for anything you care about.

---

## SDK

```ts
const { data, error } = await db.auth.signUp({
  email: "rey@example.com",
  password: "supersecret",
});
await db.auth.signIn({ email: "rey@example.com", password: "supersecret" });

const { data: me } = await db.auth.getUser();
await db.auth.refresh();
await db.auth.signOut();
```

After `signIn` / `signUp` / `refresh`, `db.from(...)` and `db.storage` send `Authorization: Bearer <accessToken>`.

The SDK does **not** write `localStorage`:

```ts
await db.auth.signIn({ email, password });
localStorage.setItem("session", JSON.stringify(db.auth.getSession()));

const saved = localStorage.getItem("session");
if (saved) db.auth.setSession(JSON.parse(saved));
```

---

## REST

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | Create account; 201 + session |
| `POST` | `/api/auth/signin` | Session |
| `POST` | `/api/auth/signout` | Bearer required; body may include `refreshToken` |
| `GET` | `/api/auth/user` | Bearer required |
| `POST` | `/api/auth/refresh` | Body `{ refreshToken }`; rotates both tokens |
| `GET` | `/api/auth/admin-registration` | `{ ownerExists }` |
| `POST` | `/api/auth/owner` | First owner bootstrap (Studio); 409 if an owner exists |
| `POST` | `/api/auth/admin-requests` | Request an admin account (202) |

Sign-up, sign-in, refresh, owner bootstrap, and admin-requests are rate-limited ([CONFIG](./CONFIG.md#security)).

### Protecting extra routes

```ts
import { createServer, requireAuth } from "@localbase/core";

const app = createServer(db, schema, {
  auth: { enabled: true, jwtSecret: "..." },
});

app.get("/api/me/orders", requireAuth(secret), (c) => {
  const user = c.get("user"); // { id, email }
});
```

---

## Roles and first owner

1. The first account created (Studio sign-up or `POST /api/auth/owner`) is the **owner**.
2. Later `signup` accounts are `user`.
3. Promote with Studio, `localbase admin promote <email>`, or the admin users API.
4. The owner cannot be demoted. Other admins cannot reset the owner’s password.
5. After an owner exists, signed-out Studio takes **admin-account requests** instead of creating another owner. Passwords are hashed immediately. Existing users prove their current password and request promotion. Only the owner approves or rejects.

CLI: [CLI](./CLI.md#auth).

---

## Row-level security

Declare `policies` when `auth.enabled` is true:

```ts
export default {
  auth: { enabled: true, jwtSecret: process.env.JWT_SECRET },
  tables: {
    notes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      user_id: { type: "integer", nullable: false },
      body: { type: "text", nullable: false },
    },
  },
  policies: {
    notes: { ownerColumn: "user_id" },
  },
};
```

On `/api/notes`:

- Unauthenticated → **401**
- `GET` / `PATCH` / `DELETE` add `user_id = <caller>`
- `POST` overwrites `user_id` with the caller
- Another user’s row looks like **404** (existence is not leaked)

Tables **without** a policy stay open on the public API (still subject to auth only if you add your own middleware).

`adminBypass: true` lets a live admin/owner skip owner filters on that table via `/api/:table`. Studio always uses `/_api/admin/*`, which is not owner-scoped.

The same policies apply to **realtime** delivery and replay. Job handlers use the `Database` class directly and **bypass HTTP RLS** by design.

---

## Admin Studio vs public API

| Surface | Who | RLS |
| --- | --- | --- |
| `/api/:table` | App clients | Owner policies apply |
| `/_api/admin/*` | Studio / admins | Gated by live admin/owner role; not owner-scoped |
| Job handlers | Server | No HTTP RLS |
