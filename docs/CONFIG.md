# Config and schema

`localbase.config.ts` is the source of truth. The CLI loads it with [jiti](https://github.com/unjs/jiti) (TypeScript works without a build step). The file must **default-export** an object with a `tables` property.

```ts
export default {
  tables: { /* required */ },
  auth?: { ... },
  policies?: { ... },
  buckets?: [ ... ],
  storage?: { ... },
  jobs?: { ... },
  realtime?: { ... },
  security?: { ... },
};
```

Types live in `@localbase/shared` (`LocalBaseConfig`). Invalid config fails at startup with a `ConfigError` and a hint — it is not ignored.

---

## Tables

Keys are table names. Values are column maps.

Names (tables and columns) must match `[a-zA-Z_][a-zA-Z0-9_]*`. Names starting with `_` are reserved for LocalBase system tables.

### Column types

| Type | SQLite | Notes |
| --- | --- | --- |
| `integer` | `INTEGER` | Whole numbers |
| `text` | `TEXT` | Strings |
| `real` | `REAL` | Floating-point |
| `boolean` | `INTEGER` | Stored as `0` / `1` |
| `blob` | `BLOB` | Binary |

### Column options

```ts
{
  type: "text",
  primaryKey: true,       // PRIMARY KEY
  autoIncrement: true,    // AUTOINCREMENT (integer PK only)
  nullable: false,        // NOT NULL (default: nullable)
  unique: true,           // UNIQUE
  default: "CURRENT_TIMESTAMP", // SQL expression, not a JS value
  references: { table: "users", column: "id" },
}
```

`default` is interpolated into DDL as written (`DEFAULT CURRENT_TIMESTAMP`, `DEFAULT 0`, `DEFAULT 'user'`). Quote string literals yourself.

Foreign keys are declared with `references`. SQLite enforces them (`PRAGMA foreign_keys = ON`). There is **no `ON DELETE CASCADE` option** in the schema — delete children before parents, or the API returns 409. The SDK does not auto-join related tables; fetch and join in the client (see the [task board](../examples/task-board/README.md)).

---

## Migrations

On open (and on config hot-reload), LocalBase:

1. **CREATE TABLE** for tables not yet recorded in `_migrations`.
2. **ADD COLUMN** for new columns on existing tables.

That is **additive only**. Dropping a column, changing a type, or adding PRIMARY KEY / UNIQUE / FK to an existing table throws. In development, change the schema and run `localbase db reset` (user tables only; system tables are kept).

SQLite also refuses some ADD COLUMN shapes (PK, UNIQUE, FK, or `NOT NULL` without a DEFAULT). Those need a reset or a fresh table.

Tables are created in dependency order (referenced tables first).

---

## `auth`

```ts
auth: {
  enabled: true,
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  accessTokenExpiry: "1h",          // jose shorthand: "30s", "15m", "7d"
  refreshTokenExpiry: 60 * 60 * 24 * 30, // seconds; default 30 days
  minPasswordLength: 8,
}
```

Auth is enabled by default, including when this section is omitted. Set
`auth: { enabled: false }` to opt out explicitly. `localbase init` writes a
stable, random per-project fallback secret. If `jwtSecret` is omitted, a random
secret is generated at startup and a warning is logged; every restart then
signs everyone out. Use a stable secret outside throwaway local use.

Details: [AUTH](./AUTH.md).

---

## `policies` (row-level security)

Requires `auth.enabled`. Each entry scopes that table’s **public** `/api/:table` routes (and matching realtime events) to the signed-in user.

```ts
policies: {
  notes: { ownerColumn: "user_id" },
  posts: { ownerColumn: "author_id", adminBypass: true },
}
```

- `ownerColumn` must exist on the table. Inserts stamp it (client cannot spoof another owner). Selects/updates/deletes AND an equality filter on it.
- Default: **everyone**, including admins, sees only their own rows on the public API. Admins still see all rows in Studio (`/_api/admin/*`).
- `adminBypass: true` lets current admin/owner roles skip scoping on the public API too. Role is re-read from `_users` on each request, not taken from the JWT claim.

Unknown table or column → startup error. [AUTH](./AUTH.md#row-level-security).

---

## `buckets` and `storage`

```ts
buckets: [
  { name: "avatars", public: true },
  { name: "documents" }, // private (default)
],

storage: {
  secret: process.env.STORAGE_SECRET, // falls back to auth.jwtSecret
  maxFileSize: 50 * 1024 * 1024,      // bytes; default ~50 MiB
},
```

Bucket names: `[a-z0-9-]{1,63}`, no leading/trailing hyphen. Undeclared buckets are created private on first upload. [STORAGE](./STORAGE.md).

---

## `jobs`

```ts
jobs: {
  cleanup_sessions: {
    schedule: "0 3 * * *",          // 5-field cron
    handler: "./jobs/cleanup-sessions.ts",
    timezone: "Asia/Kolkata",       // optional; default: server local
    enabled: true,                  // false = registered but paused
    description: "Delete expired sessions",
  },
}
```

Handler path is relative to the project cwd. [JOBS](./JOBS.md).

---

## `realtime`

Realtime is **on by default**. Disable or tune:

```ts
realtime: {
  enabled: true,
  path: "/realtime",
  eventLogSize: 1000,     // replay buffer
  presence: true,
  authTimeoutMs: 10_000,  // wait for first auth frame when auth is on
  pingIntervalMs: 30_000, // 0 disables
  limits: {
    maxSubscriptionsPerSocket: 100,
    maxFiltersPerSubscription: 16,
    maxPresenceChannelsPerSocket: 32,
    maxPresenceKeyLength: 128,
    maxPresenceMetadataBytes: 4096,
    maxMessagesPerSecond: 50,
    maxBufferedBytes: 1024 * 1024,
    maxPayloadBytes: 1024 * 1024,
  },
}
```

[REALTIME](./REALTIME.md).

---

## `security`

HTTP hardening. Defaults are loopback-safe so `localbase dev` works with a local Vite app.

```ts
security: {
  cors: {
    // Empty / omitted → only http(s)://localhost:* and 127.0.0.1:*
    allowedOrigins: ["https://app.example.com"],
    allowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // omitted allowedHeaders → reflect Access-Control-Request-Headers
    allowCredentials: false, // default; "*" origins cannot use credentials
  },
  rateLimits: {
    windowMs: 60_000, // default
    max: 20,          // per route, per IP, per window
  },
  bodyLimitBytes: 1024 * 1024, // JSON routes; Storage uses maxFileSize
  headers: {
    extra: { "Permissions-Policy": "camera=()" },
  },
  // Default false: ignore X-Forwarded-For / X-Forwarded-Host / X-Forwarded-Proto.
  // Set true only when LocalBase runs behind a trusted reverse proxy.
  trustProxy: false,
}
```

Rate limits apply to abuse-sensitive routes (sign-up, sign-in, refresh, admin-account requests, password reset, signed-URL creation). Each route has its own counter. Exceeding the budget returns **429** with `Retry-After`. Set `security.trustProxy: true` only behind a reverse proxy that strips/overwrites `X-Forwarded-*` headers; otherwise direct clients could spoof client IPs or signed-URL origins.

Default response headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. `headers.extra` overrides by name.

LocalBase does **not** terminate TLS. Put a reverse proxy in front before binding off loopback.

---

## Data directory

Default: `<cwd>/.localbase/` (`data.db`, `storage/`). Override with `LOCALBASE_DATA_DIR` (resolved against `process.cwd()`). Used by tests; rarely needed in apps.

Hot-reload watches **the config file only**. Job handler edits require restarting the process.
