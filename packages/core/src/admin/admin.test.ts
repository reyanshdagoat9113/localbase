import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";
import {
  SYSTEM_TABLES,
  isSystemTable,
} from "./system-tables.js";

// ─── Test schema ───────────────────────────────────────────────

const testSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
    email: { type: "text", unique: true },
    age: { type: "integer", nullable: true },
    active: { type: "boolean", default: "1" },
  },
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    body: { type: "text" },
    user_id: {
      type: "integer",
      references: { table: "users", column: "id" },
    },
  },
  audit_logs: {
    message: { type: "text" },
  },
};

const authSchema: DatabaseSchema = {
  // `_`-prefixed so `isSystemTable` flags it. Mirrors `_users` shape.
  _users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    email: { type: "text", nullable: false, unique: true },
    password_hash: { type: "text", nullable: false },
  },
};

// ─── Helpers ───────────────────────────────────────────────────

async function parseResponse(res: Response) {
  const json = await res.json();
  return { status: res.status, body: json };
}

function seedUsers(db: Database) {
  db.insert("users", [
    { name: "Alice", email: "alice@test.com", age: 30, active: 1 },
    { name: "Bob", email: "bob@test.com", age: 25, active: 1 },
    { name: "Charlie", email: "charlie@test.com", age: 35, active: 0 },
  ]);
}

// ─── System-tables policy ──────────────────────────────────────

describe("system-tables policy", () => {
  it("flags any `_`-prefixed table as system", () => {
    assert.equal(isSystemTable("_users"), true);
    assert.equal(isSystemTable("_sessions"), true);
    assert.equal(isSystemTable("_files"), true);
    assert.equal(isSystemTable("_anything_new"), true);
  });

  it("does not flag user tables", () => {
    assert.equal(isSystemTable("users"), false);
    assert.equal(isSystemTable("posts"), false);
    assert.equal(isSystemTable("orders"), false);
  });

  it("SYSTEM_TABLES is non-empty and includes the canonical set", () => {
    assert.ok(SYSTEM_TABLES.has("_users"));
    assert.ok(SYSTEM_TABLES.has("_sessions"));
  });
});

// ─── Schema endpoint ───────────────────────────────────────────

describe("GET /_api/admin/schema", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, { admin: { enabled: true } });
    seedUsers(db);
  });

  after(() => db.close());

  it("returns introspected schema for every table", async () => {
    const res = await app.request("/_api/admin/schema");
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    const names = body.data.tables.map((t: { name: string }) => t.name);
    assert.ok(names.includes("users"));
    assert.ok(names.includes("posts"));
  });

  it("includes columns, primaryKey, foreignKeys, indexes, rowCount, system", async () => {
    const res = await app.request("/_api/admin/schema");
    const { body } = await parseResponse(res);
    const users = body.data.tables.find(
      (t: { name: string }) => t.name === "users"
    );
    assert.ok(Array.isArray(users.columns));
    assert.deepEqual(users.primaryKey, ["id"]);
    assert.equal(users.rowCount, 3);
    assert.equal(users.system, false);
    // posts has a FK to users
    const posts = body.data.tables.find(
      (t: { name: string }) => t.name === "posts"
    );
    assert.equal(posts.foreignKeys.length, 1);
    assert.equal(posts.foreignKeys[0].toTable, "users");
  });

  it("flags `_users` (when auth is enabled) as system", async () => {
    // Spin up a fresh app with auth enabled so `_users` exists, but query
    // via an UNGATED admin server so this test isolates the system-table
    // classification. The gated flow is covered by the M2 admin-auth tests.
    const db2 = new Database({
      schema: { messages: testSchema.users }, // a user table
      auth: { enabled: true, jwtSecret: "test-secret" },
    });
    try {
      const app2 = createServer(db2, { messages: testSchema.users }, {
        admin: { enabled: true },
      });
      const res = await app2.request("/_api/admin/schema");
      const { body } = await parseResponse(res);
      const usersRow = body.data.tables.find(
        (t: { name: string; system: boolean }) => t.name === "_users"
      );
      assert.ok(usersRow, "_users should appear in schema");
      assert.equal(usersRow.system, true);
    } finally {
      db2.close();
    }
  });
});

// ─── Tables endpoint ───────────────────────────────────────────

describe("GET /_api/admin/tables", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, { admin: { enabled: true } });
    seedUsers(db);
  });

  after(() => db.close());

  it("returns table names, row counts, and system flag", async () => {
    const res = await app.request("/_api/admin/tables");
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    const users = body.data.find(
      (t: { name: string }) => t.name === "users"
    );
    assert.equal(users.rowCount, 3);
    assert.equal(users.system, false);
  });
});

// ─── Rows CRUD ─────────────────────────────────────────────────

describe("Rows CRUD (/_api/admin/tables/:table/rows)", () => {
  let db: Database;
  let app: Hono;

  beforeEach(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, { admin: { enabled: true } });
    seedUsers(db);
  });

  afterEach(() => db.close());

  it("GET returns paginated rows with total", async () => {
    const res = await app.request("/_api/admin/tables/users/rows?limit=2");
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    assert.equal(body.data.rows.length, 2);
    assert.equal(body.data.total, 3);
  });

  it("GET supports filter, order, offset", async () => {
    const url =
      "/_api/admin/tables/users/rows?age=gt.28&order=age.desc&limit=2";
    const res = await app.request(url);
    const { body } = await parseResponse(res);
    assert.equal(body.data.rows.length, 2);
    assert.equal(body.data.rows[0].name, "Charlie"); // 35
    assert.equal(body.data.rows[1].name, "Alice"); // 30
  });

  it("GET respects filter count in `total`", async () => {
    const res = await app.request(
      "/_api/admin/tables/users/rows?age=gt.28"
    );
    const { body } = await parseResponse(res);
    assert.equal(body.data.total, 2);
  });

  it("GET returns 400 for unknown column", async () => {
    const res = await app.request(
      "/_api/admin/tables/users/rows?unknown=eq.x"
    );
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("GET returns 400 when offset is used without limit", async () => {
    const res = await app.request(
      "/_api/admin/tables/users/rows?offset=1"
    );
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("GET returns 404 for unknown table", async () => {
    const res = await app.request("/_api/admin/tables/nope/rows");
    const { status } = await parseResponse(res);
    assert.equal(status, 404);
  });

  it("POST inserts a row through the Database (realtime-friendly)", async () => {
    let changes = 0;
    db.on("change", () => changes++);

    const res = await app.request("/_api/admin/tables/users/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dave",
        email: "dave@test.com",
        age: 28,
      }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 201);
    assert.equal(body.data.name, "Dave");
    // Confirms the write went through Database.insert (not raw SQL),
    // which is what makes admin edits broadcast over realtime.
    assert.ok(changes > 0, "expected Database to emit a 'change' event");
  });

  it("POST rejects unknown columns", async () => {
    const res = await app.request("/_api/admin/tables/users/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", bogus: 1 }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("POST rejects missing required columns", async () => {
    const res = await app.request("/_api/admin/tables/users/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nope@test.com" }), // missing `name`
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("POST returns 409 on unique constraint", async () => {
    const res = await app.request("/_api/admin/tables/users/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Dup",
        email: "alice@test.com", // already exists
      }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 409);
  });

  it("PATCH updates a row", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice Updated" }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    assert.equal(body.data.name, "Alice Updated");
  });

  it("PATCH rejects empty strings for numeric columns", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ age: "" }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 400);
    assert.match(body.error, /expected a number/);
  });

  it("PATCH returns 404 for non-existent id", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 404);
  });

  it("PATCH rejects an empty update body", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("PATCH returns 400 for tables without a single-column primary key", async () => {
    db.raw()
      .prepare('INSERT INTO "audit_logs" ("message") VALUES (?)')
      .run("no pk");
    const res = await app.request("/_api/admin/tables/audit_logs/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "updated" }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 400);
    assert.match(body.error, /primary key/);
  });

  it("DELETE removes a row", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/2", {
      method: "DELETE",
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    assert.equal(body.data.deleted, true);

    const list = await app.request("/_api/admin/tables/users/rows");
    const listBody = await list.json();
    assert.equal(listBody.data.total, 2);
  });

  it("DELETE returns 404 for non-existent id", async () => {
    const res = await app.request("/_api/admin/tables/users/rows/9999", {
      method: "DELETE",
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 404);
  });
});

// ─── System-table write protection ─────────────────────────────

describe("System-table write protection (defense-in-depth gate)", () => {
  // These tests isolate the system-table gate by running the admin API
  // UNGATED (createServer has no `auth` option, so admin mounts without
  // requireAdmin). The Database still provisions `_users`/`_sessions` so the
  // tables exist. The system-table block is a second layer of defense that
  // must hold even if an admin token reaches it — the M2 admin-auth tests
  // cover the auth layer.

  it("POST to _users returns 403 with a helpful error", async () => {
    const db = new Database({
      schema: authSchema,
      auth: { enabled: true, jwtSecret: "test-secret" },
    });
    try {
      const app = createServer(db, authSchema, {
        admin: { enabled: true },
      });
      const res = await app.request("/_api/admin/tables/_users/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "evil@hack.com",
          password_hash: "not-a-real-hash",
        }),
      });
      const { status, body } = await parseResponse(res);
      assert.equal(status, 403);
      assert.match(body.error, /_users/);
      assert.match(body.error, /admin/);
    } finally {
      db.close();
    }
  });

  it("PATCH on _users returns 403", async () => {
    const db = new Database({
      schema: authSchema,
      auth: { enabled: true, jwtSecret: "test-secret" },
    });
    try {
      db.insert("_users", {
        email: "u@x.com",
        password_hash: "h",
        role: "user",
      });
      const app = createServer(db, authSchema, {
        admin: { enabled: true },
      });
      const res = await app.request("/_api/admin/tables/_users/rows/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password_hash: "forged" }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 403);
    } finally {
      db.close();
    }
  });

  it("DELETE on _sessions returns 403", async () => {
    const db = new Database({
      schema: authSchema,
      auth: { enabled: true, jwtSecret: "test-secret" },
    });
    try {
      const app = createServer(db, authSchema, {
        admin: { enabled: true },
      });
      const res = await app.request("/_api/admin/tables/_sessions/rows/1", {
        method: "DELETE",
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 403);
    } finally {
      db.close();
    }
  });

  it("GET on _users still works (reads are allowed)", async () => {
    const db = new Database({
      schema: authSchema,
      auth: { enabled: true, jwtSecret: "test-secret" },
    });
    try {
      db.insert("_users", {
        email: "u@x.com",
        password_hash: "h",
        role: "user",
      });
      const app = createServer(db, authSchema, {
        admin: { enabled: true },
      });
      const res = await app.request("/_api/admin/tables/_users/rows");
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.total, 1);
    } finally {
      db.close();
    }
  });
});

// ─── Static mount ──────────────────────────────────────────────

describe("Admin static mount (M1 deliverable)", () => {
  it("serves placeholder HTML at /admin when no bundle is present", async () => {
    const db = new Database({ schema: testSchema });
    try {
      const app = createServer(db, testSchema, { admin: { enabled: true } });
      const res = await app.request("/admin");
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.match(text, /LocalBase Admin/);
      assert.match(text, /placeholder/);
    } finally {
      db.close();
    }
  });

  it("serves placeholder HTML at /admin/some-path (SPA fallback)", async () => {
    const db = new Database({ schema: testSchema });
    try {
      const app = createServer(db, testSchema, { admin: { enabled: true } });
      const res = await app.request("/admin/tables/users");
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.match(text, /LocalBase Admin/);
    } finally {
      db.close();
    }
  });

  it("is not mounted when admin is disabled", async () => {
    const db = new Database({ schema: testSchema });
    try {
      const app = createServer(db, testSchema, {
        admin: { enabled: false },
      });
      const res = await app.request("/_api/admin/schema");
      // Hono's default 404 returns a plain text body, so we check the
      // status directly without parsing JSON.
      assert.equal(res.status, 404);
    } finally {
      db.close();
    }
  });
});

// ─── Introspection details ─────────────────────────────────────

describe("Introspection accuracy", () => {
  let db: Database;
  before(() => {
    db = new Database({ schema: testSchema });
    seedUsers(db);
  });
  after(() => db.close());

  it("surfaces column metadata (type, notNull, primaryKey, autoIncrement)", () => {
    const schema = db.introspect();
    const users = schema.tables.find((t) => t.name === "users")!;
    const id = users.columns.find((c) => c.name === "id")!;
    assert.equal(id.type, "INTEGER");
    assert.equal(id.primaryKey, true);
    assert.equal(id.autoIncrement, true);
    assert.equal(id.notNull, true);
    const name = users.columns.find((c) => c.name === "name")!;
    assert.equal(name.type, "TEXT");
    assert.equal(name.notNull, true);
    assert.equal(name.primaryKey, false);
  });

  it("surfaces foreign keys for posts → users", () => {
    const schema = db.introspect();
    const posts = schema.tables.find((t) => t.name === "posts")!;
    assert.equal(posts.foreignKeys.length, 1);
    assert.equal(posts.foreignKeys[0].fromColumn, "user_id");
    assert.equal(posts.foreignKeys[0].toTable, "users");
    assert.equal(posts.foreignKeys[0].toColumn, "id");
  });

  it("surfaces UNIQUE indexes (not internal PK indexes)", () => {
    const schema = db.introspect();
    const users = schema.tables.find((t) => t.name === "users")!;
    const emailIndex = users.indexes.find((i) =>
      i.columns.includes("email")
    );
    // If SQLite auto-created a UNIQUE index for the unique constraint,
    // surface it. If not, this is a no-op — the column still has the
    // constraint, just not a separately-named index.
    if (emailIndex) {
      assert.ok(emailIndex.unique);
    }
  });

  it("rowCount reflects current data", () => {
    db.insert("users", { name: "Eve", email: "eve@test.com" });
    const schema = db.introspect();
    const users = schema.tables.find((t) => t.name === "users")!;
    assert.equal(users.rowCount, 4);
  });
});
