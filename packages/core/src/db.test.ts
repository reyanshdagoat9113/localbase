import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { schemaToDDL, tableToDDL, columnToDDL } from "./ddl.js";
import type { DatabaseSchema, TableSchema } from "@localbase/shared";

// ─── Test schemas ──────────────────────────────────────────────

const simpleSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
    email: { type: "text", unique: true },
    age: { type: "integer", nullable: true },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
};

const relationalSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
    email: { type: "text", unique: true },
  },
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    body: { type: "text" },
    user_id: {
      type: "integer",
      references: { table: "users", column: "id" },
    },
    published: { type: "boolean", default: "0" },
  },
};

// ─── DDL Compiler Tests ────────────────────────────────────────

describe("DDL Compiler", () => {
  it("should generate a basic column definition", () => {
    const result = columnToDDL("name", { type: "text", nullable: false });
    assert.equal(result, '"name" TEXT NOT NULL');
  });

  it("should handle primary key with autoincrement", () => {
    const result = columnToDDL("id", {
      type: "integer",
      primaryKey: true,
      autoIncrement: true,
    });
    assert.equal(result, '"id" INTEGER PRIMARY KEY AUTOINCREMENT');
  });

  it("should handle unique constraint", () => {
    const result = columnToDDL("email", { type: "text", unique: true });
    assert.equal(result, '"email" TEXT UNIQUE');
  });

  it("should handle default values", () => {
    const result = columnToDDL("created_at", {
      type: "text",
      default: "CURRENT_TIMESTAMP",
    });
    assert.equal(result, '"created_at" TEXT DEFAULT CURRENT_TIMESTAMP');
  });

  it("should map boolean to INTEGER", () => {
    const result = columnToDDL("active", { type: "boolean" });
    assert.equal(result, '"active" INTEGER');
  });

  it("should generate a CREATE TABLE statement", () => {
    const result = tableToDDL("users", simpleSchema.users);
    assert.ok(result.includes("CREATE TABLE IF NOT EXISTS"));
    assert.ok(result.includes('"users"'));
    assert.ok(result.includes('"id" INTEGER PRIMARY KEY AUTOINCREMENT'));
    assert.ok(result.includes('"name" TEXT NOT NULL'));
    assert.ok(result.includes('"email" TEXT UNIQUE'));
  });

  it("should handle foreign key references", () => {
    const result = tableToDDL("posts", relationalSchema.posts);
    assert.ok(result.includes('FOREIGN KEY ("user_id") REFERENCES "users"("id")'));
  });

  it("should topologically sort tables with foreign keys", () => {
    const ddl = schemaToDDL(relationalSchema);
    assert.equal(ddl.length, 2);
    // users should come before posts (posts references users)
    assert.ok(ddl[0].includes('"users"'));
    assert.ok(ddl[1].includes('"posts"'));
  });

  it("should throw on circular dependencies", () => {
    const circular: DatabaseSchema = {
      a: {
        id: { type: "integer", primaryKey: true },
        b_id: { type: "integer", references: { table: "b", column: "id" } },
      },
      b: {
        id: { type: "integer", primaryKey: true },
        a_id: { type: "integer", references: { table: "a", column: "id" } },
      },
    };
    assert.throws(() => schemaToDDL(circular), /Circular/);
  });
});

// ─── Migration Tests ───────────────────────────────────────────

describe("Migrations", () => {
  it("should run migrations and create tables", () => {
    const db = new Database({ schema: simpleSchema });
    const applied = db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    db.close();
  });

  it("should track applied migrations", () => {
    const db = new Database({ schema: relationalSchema });
    const applied = db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    assert.ok(applied.has("posts"));
    // The storage subsystem adds the `_files` system table automatically.
    assert.ok(applied.has("_files"));
    assert.equal(applied.size, 3);
    db.close();
  });

  it("should skip already applied migrations", () => {
    const db = new Database({ schema: simpleSchema });
    const first = db.migrate();
    assert.equal(first.length, 0); // nothing new to apply
    db.close();
  });

  it("should detect tables exist after migration", () => {
    const db = new Database({ schema: simpleSchema });
    // Query sqlite_master to verify table exists
    const tables = db
      .raw()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`
      )
      .all();
    assert.equal(tables.length, 1);
    db.close();
  });

  it("should reset database and re-run migrations", () => {
    const db = new Database({ schema: simpleSchema });
    db.insert("users", { name: "Test", email: "test@test.com" });
    const before = db.select("users");
    assert.equal(before.length, 1);

    db.reset();
    const after = db.select("users");
    assert.equal(after.length, 0);

    const applied = db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    db.close();
  });

  it("should handle foreign key relationships", () => {
    const db = new Database({ schema: relationalSchema });
    const user = db.insert("users", { name: "Reyansh", email: "r@r.com" });
    const userId = (user[0] as Record<string, unknown>).id;

    db.insert("posts", {
      title: "First Post",
      body: "Hello world",
      user_id: userId,
    });

    const posts = db.select("posts");
    assert.equal(posts.length, 1);
    assert.equal((posts[0] as Record<string, unknown>).user_id, userId);
    db.close();
  });
});

// ─── Query Executor Tests ──────────────────────────────────────

describe("Query Executor", () => {
  let db: Database;

  before(() => {
    db = new Database({ schema: simpleSchema });
    db.insert("users", [
      { name: "Alice", email: "alice@test.com", age: 30 },
      { name: "Bob", email: "bob@test.com", age: 25 },
      { name: "Charlie", email: "charlie@test.com", age: 35 },
    ]);
  });

  after(() => {
    db.close();
  });

  // -- SELECT --

  describe("select", () => {
    it("should return all rows", () => {
      const rows = db.select("users");
      assert.equal(rows.length, 3);
    });

    it("should filter with eq", () => {
      const rows = db.select("users", {
        filters: [{ column: "name", operator: "eq", value: "Alice" }],
      });
      assert.equal(rows.length, 1);
      assert.equal(
        (rows[0] as Record<string, unknown>).name,
        "Alice"
      );
    });

    it("should filter with neq", () => {
      const rows = db.select("users", {
        filters: [{ column: "name", operator: "neq", value: "Alice" }],
      });
      assert.equal(rows.length, 2);
    });

    it("should filter with gt", () => {
      const rows = db.select("users", {
        filters: [{ column: "age", operator: "gt", value: 28 }],
      });
      assert.equal(rows.length, 2); // Alice(30), Charlie(35)
    });

    it("should filter with lt", () => {
      const rows = db.select("users", {
        filters: [{ column: "age", operator: "lt", value: 30 }],
      });
      assert.equal(rows.length, 1); // Bob(25)
    });

    it("should filter with gte", () => {
      const rows = db.select("users", {
        filters: [{ column: "age", operator: "gte", value: 30 }],
      });
      assert.equal(rows.length, 2);
    });

    it("should filter with lte", () => {
      const rows = db.select("users", {
        filters: [{ column: "age", operator: "lte", value: 25 }],
      });
      assert.equal(rows.length, 1);
    });

    it("should filter with like", () => {
      const rows = db.select("users", {
        filters: [{ column: "name", operator: "like", value: "%li%" }],
      });
      assert.equal(rows.length, 2); // Alice, Charlie
    });

    it("should filter with in", () => {
      const rows = db.select("users", {
        filters: [
          { column: "name", operator: "in", value: ["Alice", "Bob"] },
        ],
      });
      assert.equal(rows.length, 2);
    });

    it("should order results ascending", () => {
      const rows = db.select("users", {
        orderBy: [{ column: "age", direction: "asc" }],
      });
      assert.equal(
        (rows[0] as Record<string, unknown>).name,
        "Bob"
      );
      assert.equal(
        (rows[2] as Record<string, unknown>).name,
        "Charlie"
      );
    });

    it("should order results descending", () => {
      const rows = db.select("users", {
        orderBy: [{ column: "age", direction: "desc" }],
      });
      assert.equal(
        (rows[0] as Record<string, unknown>).name,
        "Charlie"
      );
    });

    it("should limit results", () => {
      const rows = db.select("users", { limit: 2 });
      assert.equal(rows.length, 2);
    });

    it("should offset results", () => {
      const rows = db.select("users", { limit: 2, offset: 1 });
      assert.equal(rows.length, 2);
    });

    it("should select by id", () => {
      const all = db.select("users");
      const firstId = (all[0] as Record<string, unknown>).id as number;
      const row = db.selectById("users", firstId);
      assert.ok(row);
      assert.equal((row as Record<string, unknown>).id, firstId);
    });

    it("should combine filters", () => {
      const rows = db.select("users", {
        filters: [
          { column: "age", operator: "gte", value: 25 },
          { column: "age", operator: "lte", value: 30 },
        ],
      });
      assert.equal(rows.length, 2); // Alice(30), Bob(25)
    });
  });

  // -- INSERT --

  describe("insert", () => {
    it("should insert a single row", () => {
      const result = db.insert("users", {
        name: "Dave",
        email: "dave@test.com",
        age: 28,
      });
      assert.equal(result.length, 1);
      assert.equal(
        (result[0] as Record<string, unknown>).name,
        "Dave"
      );
      assert.ok((result[0] as Record<string, unknown>).id);
    });

    it("should insert multiple rows", () => {
      const result = db.insert("users", [
        { name: "Eve", email: "eve@test.com", age: 22 },
        { name: "Frank", email: "frank@test.com", age: 40 },
      ]);
      assert.equal(result.length, 2);
    });

    it("should set default values", () => {
      const result = db.insert("users", {
        name: "Grace",
        email: "grace@test.com",
      });
      assert.ok(
        (result[0] as Record<string, unknown>).created_at
      );
    });

    it("should reject duplicate unique values", () => {
      assert.throws(
        () =>
          db.insert("users", { name: "Dup", email: "alice@test.com" }),
        /UNIQUE/
      );
    });
  });

  // -- UPDATE --

  describe("update", () => {
    it("should update rows matching filter", () => {
      const result = db.update(
        "users",
        { name: "Alice Updated" },
        [{ column: "name", operator: "eq", value: "Alice" }]
      );
      assert.equal(result.length, 1);
      assert.equal(
        (result[0] as Record<string, unknown>).name,
        "Alice Updated"
      );
    });

    it("should update multiple rows", () => {
      const result = db.update(
        "users",
        { age: 99 },
        [{ column: "age", operator: "lt", value: 25 }]
      );
      // Eve(22) should be updated
      for (const row of result) {
        assert.equal((row as Record<string, unknown>).age, 99);
      }
    });
  });

  // -- DELETE --

  describe("delete", () => {
    it("should delete rows matching filter", () => {
      const count = db.delete("users", [
        { column: "name", operator: "eq", value: "Frank" },
      ]);
      assert.equal(count, 1);
      const remaining = db.select("users", {
        filters: [{ column: "name", operator: "eq", value: "Frank" }],
      });
      assert.equal(remaining.length, 0);
    });

    it("should return 0 when no rows match", () => {
      const count = db.delete("users", [
        { column: "name", operator: "eq", value: "NonExistent" },
      ]);
      assert.equal(count, 0);
    });
  });
});
