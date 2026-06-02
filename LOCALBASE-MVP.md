# 🚀 LocalBase MVP

> Define a schema → get a running API → query it with an SDK. Nothing else.

---

## Project Setup

Monorepo with npm workspaces.

```
localbase/
├── packages/
│   ├── cli/           → @localbase/cli
│   ├── core/          → @localbase/core (db + api)
│   ├── sdk/           → @localbase/sdk
│   └── shared/        → types & utils
├── package.json
└── tsconfig.json
```

| Tool      | Choice             |
|-----------|--------------------|
| Runtime   | Node.js            |
| Language  | TypeScript         |
| Database  | SQLite (better-sqlite3) |
| API       | Hono               |
| CLI       | Commander.js       |
| SDK       | fetch (zero deps)  |
| Build     | tsup               |
| Monorepo  | npm workspaces     |

---

## Build Phases

### Phase 1: Project Scaffolding ✅ DONE

Set up the monorepo. Get `npm run build` working across all packages.

- [x] Init npm monorepo with workspace config
- [x] Create all 4 packages with `package.json` and `tsconfig.json`
- [x] Add `tsup` build config to each package
- [x] Add `shared` as dependency to `core`, `cli`, `sdk`
- [x] Verify `npm run build -ws` compiles all packages with no errors

---

### Phase 2: Database Layer (`packages/core`) ✅ DONE

Read schema → create SQLite tables → run queries.

**Schema format:**

```ts
// localbase.config.ts
export default {
  tables: {
    users: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
      email: { type: "text", unique: true },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
  },
};
```

- [x] Define `TableSchema` and `ColumnSchema` types in `shared`
- [x] Build schema → DDL compiler (`CREATE TABLE`, column types, constraints)
- [x] Implement migration tracking (`_migrations` table in SQLite)
- [x] Implement migration runner (apply pending, skip applied)
- [x] Build query executor: `select`, `insert`, `update`, `delete`
- [x] Support foreign keys and relationships
- [x] Write unit tests for: DDL generation, migrations, all CRUD operations

---

### Phase 3: REST API (`packages/core`) ✅ DONE

Auto-generate CRUD endpoints from schema.

```
GET    /api/:table         → list (filter, sort, paginate)
POST   /api/:table         → insert
GET    /api/:table/:id     → get one
PATCH  /api/:table/:id     → update
DELETE /api/:table/:id     → delete
```

**Query params:**
- `?order=created_at.desc&limit=10`
- `?email=eq.reyansh@example.com`

- [x] Scaffold Hono server with `/api/:table` routes
- [x] Wire routes to query executor from Phase 2
- [x] Implement filtering (`eq`, `neq`, `gt`, `lt`, `like`)
- [x] Implement sorting (`order`), pagination (`limit`, `offset`)
- [x] Add input validation (reject unknown columns, wrong types)
- [x] Add error responses with proper HTTP status codes
- [x] Write integration tests for every endpoint and filter

---

### Phase 4: CLI (`packages/cli`) ✅ DONE

```
localbase init         → scaffold project + config file
localbase dev          → start dev server (watches schema, hot-reload)
localbase db migrate   → run pending migrations
localbase db reset     → drop all tables, re-run migrations
```

- [x] Set up Commander.js with all 4 commands
- [x] `init`: create `.localbase/` dir, `localbase.config.ts`, example schema
- [x] `dev`: start Hono server, watch config file for changes, reload on save
- [x] `db migrate`: load config, run migration runner, print status
- [x] `db reset`: drop tables, re-run all migrations
- [x] Add colored output (picocolors) for success/error/status messages
- [x] Add `npx @localbase/cli` support (bin field in package.json)

---

### Phase 5: SDK (`packages/sdk`)

```ts
import { createClient } from "@localbase/sdk";
const db = createClient("http://localhost:54321");

await db.from("users").select("*");
await db.from("users").select("*").eq("id", 1).single();
await db.from("users").insert({ name: "Reyansh" });
await db.from("users").update({ name: "New" }).eq("id", 1);
await db.from("users").delete().eq("id", 1);
```

- [ ] Build chainable query builder: `from().select().eq().order().limit()`
- [ ] Implement filters: `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `in`
- [ ] Implement modifiers: `order`, `limit`, `offset`, `single`
- [ ] Implement `insert`, `update`, `delete` terminators
- [ ] Compile builder state → URL query params → fetch call
- [ ] Parse response into `{ data, error }` shape
- [ ] Write tests against a running dev server

---

### Phase 6: Polish

- [ ] End-to-end test: `init` → define schema → `dev` → query via SDK → assert results
- [ ] Error handling: clear messages for missing config, bad schema, connection refused
- [ ] Add `--port` flag to `dev` command (default 54321)
- [ ] Add `--help` to all CLI commands
- [ ] README with quickstart guide

---

## Not in MVP

Auth · Storage · Realtime · Admin Studio · PostgreSQL · DevDesk · GraphQL · Cloud sync

---

## Done When

1. `npx @localbase/cli init` scaffolds a project
2. Developer defines tables in config
3. `localbase dev` starts server with REST API
4. SDK can CRUD data
5. `localhost:54321/api/users` returns JSON in browser
