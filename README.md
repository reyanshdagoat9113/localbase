# 🗄️ LocalBase

> Local-first backend platform. Define a schema, get a running API, query it with an SDK.

[![Phase 1-6 MVP](https://img.shields.io/badge/MVP-Complete-green)](LOCALBASE-MVP.md)

---

## Quickstart

```bash
# Scaffold a new project
npx @localbase/cli init

# Start the dev server
localbase dev
```

That's it. You now have a REST API running at `http://localhost:54321`.

---

## What you get

- **SQLite database** with auto-migrations
- **REST API** auto-generated from your schema
- **TypeScript SDK** with a Supabase-style query builder
- **Hot-reload** on schema changes
- **Zero config** — define tables, everything else is automatic

---

## Define your schema

Edit `localbase.config.ts`:

```ts
export default {
  tables: {
    users: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
      email: { type: "text", unique: true },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    posts: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      body: { type: "text" },
      user_id: { type: "integer", references: { table: "users", column: "id" } },
    },
  },
};
```

Save the file — the dev server hot-reloads automatically.

---

## CLI commands

```
localbase init             Scaffold a new project (creates .localbase/ + config file)
localbase dev              Start dev server (port 54321, hot-reload on schema change)
localbase dev --port 4000  Start on a custom port
localbase db migrate       Run pending migrations + show status
localbase db reset         Drop all tables, re-run migrations from scratch
localbase --help           Show all commands
```

---

## REST API

Auto-generated CRUD per table:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/:table` | List rows (filter, sort, paginate) |
| `POST` | `/api/:table` | Insert a row |
| `GET` | `/api/:table/:id` | Get a single row |
| `PATCH` | `/api/:table/:id` | Update a row |
| `DELETE` | `/api/:table/:id` | Delete a row |

### Query parameters

```
GET /api/users?age=gte.25&order=created_at.desc&limit=10
```

| Param | Format | Example |
|---|---|---|
| Filter | `?col=op.value` | `?age=gte.25` |
| Sort | `?order=col.dir` | `?order=created_at.desc` |
| Limit | `?limit=N` | `?limit=10` |
| Offset | `?offset=N` | `?offset=20` |

**Filter operators:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `in`

**IN example:** `?name=in.Alice,Bob,Charlie`

---

## SDK

```ts
import { createClient } from "@localbase/sdk";

const db = createClient("http://localhost:54321");

// SELECT
const users = await db.from("users").select("*");
const alice = await db.from("users").select("*").eq("name", "Alice").single();

// INSERT
await db.from("users").insert({ name: "Reyansh", email: "r@r.com" });

// UPDATE (by id)
await db.from("users").update({ name: "New Name" }).eq("id", 1);

// DELETE (by id)
await db.from("users").delete().eq("id", 1);

// FILTERS
await db.from("users")
  .select("*")
  .eq("age", 30)
  .gte("age", 25)
  .lt("age", 60)
  .like("name", "%rey%")
  .in("name", ["Alice", "Bob"]);

// SORT + PAGINATE
await db.from("users")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(10)
  .offset(20);
```

All SDK methods return `{ data, error }`:

```ts
const { data, error } = await db.from("users").select("*");
if (error) console.error(error);
else console.log(data);
```

---

## Column types

| Type | SQLite mapping | Notes |
|---|---|---|
| `integer` | `INTEGER` | Whole numbers |
| `text` | `TEXT` | Strings |
| `real` | `REAL` | Floating-point |
| `boolean` | `INTEGER` | Stored as 0/1 |
| `blob` | `BLOB` | Binary data |

### Column options

```ts
{
  type: "text",
  primaryKey: true,      // PK constraint
  autoIncrement: true,   // AUTOINCREMENT (use with PK + integer)
  nullable: false,       // NOT NULL (default: nullable)
  unique: true,          // UNIQUE constraint
  default: "CURRENT_TIMESTAMP",  // DEFAULT value (SQL expression)
  references: { table: "users", column: "id" },  // FK
}
```

---

## Project structure (after `init`)

```
your-project/
├── .localbase/
│   └── data.db          SQLite database (auto-created)
└── localbase.config.ts  Schema definition
```

---

## HTTP status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created (insert) |
| `400` | Bad request (validation error) |
| `404` | Not found (unknown table / row missing) |
| `409` | Conflict (UNIQUE constraint violation) |
| `500` | Internal server error |

---

## Roadmap

MVP is complete. See [`LOCALBASE-POST-MVP.md`](LOCALBASE-POST-MVP.md) for upcoming features:

- **Phase 7:** Realtime (WebSockets + subscriptions)
- **Phase 8:** Scheduled Jobs (cron + handlers)
- **Phase 9:** Storage (file uploads + signed URLs)

---

## License

MIT
