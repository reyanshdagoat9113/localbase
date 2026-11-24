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
    assert.equal(
      result,
      `"created_at" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );
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
  it("should run migrations and create tables", async () => {
    const db = await Database.open({ schema: simpleSchema });
    const applied = await db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    await db.close();
  });

  it("should track applied migrations", async () => {
    const db = await Database.open({ schema: relationalSchema });
    const applied = await db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    assert.ok(applied.has("posts"));
    // The storage subsystem adds the `_files` system table automatically.
    assert.ok(applied.has("_files"));
    assert.equal(applied.size, 3);
    await db.close();
  });

  it("should skip already applied migrations", async () => {
    const db = await Database.open({ schema: simpleSchema });
    const first = await db.migrate();
    assert.equal(first.length, 0); // nothing new to apply
    await db.close();
  });

  it("should detect tables exist after migration", async () => {
    const db = await Database.open({ schema: simpleSchema });
    // Query sqlite_master to verify table exists
    const tables = db
      .sqliteRaw()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`
      )
      .all();
    assert.equal(tables.length, 1);
    await db.close();
  });

  it("should reset database and re-run migrations", async () => {
    const db = await Database.open({ schema: simpleSchema });
    await db.insert("users", { name: "Test", email: "test@test.com" });
    const before = await db.select("users");
    assert.equal(before.length, 1);

    await db.reset();
    const after = await db.select("users");
    assert.equal(after.length, 0);

    const applied = await db.getAppliedMigrations();
    assert.ok(applied.has("users"));
    await db.close();
  });

  it("should handle foreign key relationships", async () => {
    const db = await Database.open({ schema: relationalSchema });
    const user = await db.insert("users", { name: "Reyansh", email: "r@r.com" });
    const userId = (user[0] as Record<string, unknown>).id;

    await db.insert("posts", {
      title: "First Post",
      body: "Hello world",
      user_id: userId,
    });

    const posts = await db.select("posts");
    assert.equal(posts.length, 1);
    assert.equal((posts[0] as Record<string, unknown>).user_id, userId);
    await db.close();
  });
});

// ─── Query Executor Tests ──────────────────────────────────────

describe("Query Executor", () => {
  let db: Database;

  before(async () => {
    db = await Database.open({ schema: simpleSchema });
    await db.insert("users", [
      { name: "Alice", email: "alice@test.com", age: 30 },
      { name: "Bob", email: "bob@test.com", age: 25 },
      { name: "Charlie", email: "charlie@test.com", age: 35 },
    ]);
  });

  after(async () => {
    await db.close();
  });

  // -- SELECT --

  describe("select", () => {
    it("should return all rows", async () => {
      const rows = await db.select("users");
      assert.equal(rows.length, 3);
    });

    it("should filter with eq", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "name", operator: "eq", value: "Alice" }],
      });
      assert.equal(rows.length, 1);
      assert.equal(
        (rows[0] as Record<string, unknown>).name,
        "Alice"
      );
    });

    it("should filter with neq", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "name", operator: "neq", value: "Alice" }],
      });
      assert.equal(rows.length, 2);
    });

    it("should filter with gt", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "age", operator: "gt", value: 28 }],
      });
      assert.equal(rows.length, 2); // Alice(30), Charlie(35)
    });

    it("should filter with lt", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "age", operator: "lt", value: 30 }],
      });
      assert.equal(rows.length, 1); // Bob(25)
    });

    it("should filter with gte", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "age", operator: "gte", value: 30 }],
      });
      assert.equal(rows.length, 2);
    });

    it("should filter with lte", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "age", operator: "lte", value: 25 }],
      });
      assert.equal(rows.length, 1);
    });

    it("should filter with like", async () => {
      const rows = await db.select("users", {
        filters: [{ column: "name", operator: "like", value: "%li%" }],
      });
      assert.equal(rows.length, 2); // Alice, Charlie
    });

    it("should filter with in", async () => {
      const rows = await db.select("users", {
        filters: [
          { column: "name", operator: "in", value: ["Alice", "Bob"] },
        ],
      });
      assert.equal(rows.length, 2);
    });

    it("should order results ascending", async () => {
      const rows = await db.select("users", {
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

    it("should order results descending", async () => {
      const rows = await db.select("users", {
        orderBy: [{ column: "age", direction: "desc" }],
      });
      assert.equal(
        (rows[0] as Record<string, unknown>).name,
        "Charlie"
      );
    });

    it("should limit results", async () => {
      const rows = await db.select("users", { limit: 2 });
      assert.equal(rows.length, 2);
    });

    it("should offset results", async () => {
      const rows = await db.select("users", { limit: 2, offset: 1 });
      assert.equal(rows.length, 2);
    });

    it("should select by id", async () => {
      const all = await db.select("users");
      const firstId = (all[0] as Record<string, unknown>).id as number;
      const row = await db.selectById("users", firstId);
      assert.ok(row);
      assert.equal((row as Record<string, unknown>).id, firstId);
    });

    it("should combine filters", async () => {
      const rows = await db.select("users", {
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
    it("should insert a single row", async () => {
      const result = await db.insert("users", {
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

    it("should insert multiple rows", async () => {
      const result = await db.insert("users", [
        { name: "Eve", email: "eve@test.com", age: 22 },
        { name: "Frank", email: "frank@test.com", age: 40 },
      ]);
      assert.equal(result.length, 2);
    });

    it("should set ISO-8601 UTC default timestamp values", async () => {
      const result = await db.insert("users", {
        name: "Grace",
        email: "grace@test.com",
      });
      const createdAt = (result[0] as Record<string, unknown>).created_at;
      assert.equal(typeof createdAt, "string");
      assert.match(
        createdAt as string,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });

    it("should reject duplicate unique values", async () => {
      await assert.rejects(
        async () =>
          await db.insert("users", { name: "Dup", email: "alice@test.com" }),
        /UNIQUE/
      );
    });
  });

  // -- UPDATE --

  describe("update", () => {
    it("should update rows matching filter", async () => {
      const result = await db.update(
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

    it("should update multiple rows", async () => {
      const result = await db.update(
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
    it("should delete rows matching filter", async () => {
      const count = await db.delete("users", [
        { column: "name", operator: "eq", value: "Frank" },
      ]);
      assert.equal(count, 1);
      const remaining = await db.select("users", {
        filters: [{ column: "name", operator: "eq", value: "Frank" }],
      });
      assert.equal(remaining.length, 0);
    });

    it("should return 0 when no rows match", async () => {
      const count = await db.delete("users", [
        { column: "name", operator: "eq", value: "NonExistent" },
      ]);
      assert.equal(count, 0);
    });
  });

  // -- introspectTable --

  describe("introspectTable", () => {
    it("returns metadata for a single table and null for unknown tables", async () => {
      const users = await db.introspectTable("users");
      assert.ok(users);
      assert.equal(users.name, "users");
      assert.ok(users.columns.some((c) => c.name === "email"));
      assert.deepEqual(users.primaryKey, ["id"]);

      const missing = await db.introspectTable("does_not_exist");
      assert.equal(missing, null);
    });
  });

  // -- SqliteDriver transaction isolation --

  describe("SqliteDriver transaction isolation", () => {
    it("serializes non-tx writes so they are not rolled back when a concurrent tx fails", async () => {
      const txDb = await Database.open({ schema: simpleSchema });
      try {
        let txEntered!: () => void;
        const enteredPromise = new Promise<void>((r) => {
          txEntered = r;
        });
        let releaseTx!: () => void;
        const releasePromise = new Promise<void>((r) => {
          releaseTx = r;
        });

        const txPromise = txDb.transaction(async () => {
          await txDb.insert("users", {
            name: "RolledBack",
            email: "rb@test.com",
          });
          txEntered();
          await releasePromise;
          throw new Error("abort tx");
        });

        await enteredPromise;

        // Issue a non-tx write while tx is mid-await. It must queue behind the
        // tx and survive the tx rollback.
        const nonTxWrite = txDb.insert("users", {
          name: "Survivor",
          email: "survivor@test.com",
        });

        releaseTx();
        await assert.rejects(txPromise, /abort tx/);
        await nonTxWrite;

        const rows = (await txDb.select("users")) as { email: string }[];
        assert.deepEqual(
          rows.map((r) => r.email),
          ["survivor@test.com"]
        );
      } finally {
        await txDb.close();
      }
    });

    it("prevents non-tx reads from observing uncommitted rows during an open tx", async () => {
      const txDb = await Database.open({ schema: simpleSchema });
      try {
        let txInserted!: () => void;
        const insertedPromise = new Promise<void>((r) => {
          txInserted = r;
        });
        let finishTx!: () => void;
        const finishPromise = new Promise<void>((r) => {
          finishTx = r;
        });

        let readCompletedDuringTx = false;
        const txPromise = txDb.transaction(async () => {
          await txDb.insert("users", {
            name: "Uncommitted",
            email: "uncommitted@test.com",
          });
          txInserted();
          await finishPromise;
          throw new Error("rollback");
        });

        await insertedPromise;

        // Start a non-tx read while the tx is open; it must wait until after
        // the tx finishes and must never observe the uncommitted row.
        const readPromise = txDb.select("users").then((rows) => {
          readCompletedDuringTx = true;
          return rows;
        });

        // Yield a tick to confirm the read did NOT run inside the open tx.
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(readCompletedDuringTx, false);

        finishTx();
        await assert.rejects(txPromise, /rollback/);
        const rows = await readPromise;
        assert.equal(rows.length, 0);
      } finally {
        await txDb.close();
      }
    });

    it("rejects nested transaction() calls with a clear error instead of deadlocking", async () => {
      const txDb = await Database.open({ schema: simpleSchema });
      try {
        await assert.rejects(
          async () =>
            await txDb.transaction(async () => {
              await txDb.transaction(async () => {});
            }),
          /Nested transactions are not supported/
        );
      } finally {
        await txDb.close();
      }
    });

    it("does not leak stale ALS tx context to async continuations spawned inside a finished tx", async () => {
      const txDb = await Database.open({ schema: simpleSchema });
      try {
        let leakedWrite!: Promise<unknown>;
        let leakedTx!: Promise<unknown>;

        await txDb.transaction(async () => {
          // Spawn async continuations that inherit the ALS store and run AFTER tx1 commits.
          leakedWrite = new Promise((r) => setTimeout(r, 20)).then(() =>
            txDb.insert("users", {
              name: "UnrelatedWrite",
              email: "unrelated@test.com",
            })
          );
          leakedTx = new Promise((r) => setTimeout(r, 25)).then(() =>
            txDb.transaction(async () => {
              await txDb.insert("users", {
                name: "LeakedTx",
                email: "leakedtx@test.com",
              });
            })
          );
        });

        // Start tx2 which stays open across the timers and then rolls back.
        await txDb
          .transaction(async () => {
            await new Promise((r) => setTimeout(r, 60));
            throw new Error("tx2 rollback");
          })
          .catch(() => {});

        await leakedWrite;
        await leakedTx;

        const rows = (await txDb.select("users")) as { email: string }[];
        const emails = rows.map((r) => r.email).sort();
        assert.deepEqual(emails, ["leakedtx@test.com", "unrelated@test.com"]);
      } finally {
        await txDb.close();
      }
    });

    it("rejects calls made directly on a finished tx handle", async () => {
      const txDb = await Database.open({ schema: simpleSchema });
      try {
        let savedTx!: Parameters<Parameters<typeof txDb.transaction>[0]>[0];
        await txDb.transaction(async (tx) => {
          savedTx = tx;
        });

        await assert.rejects(
          () => savedTx.query("SELECT 1"),
          /Transaction has already finished/
        );
      } finally {
        await txDb.close();
      }
    });

    it("normalizes legacy non-0/1 numbers and string booleans on read", async () => {
      const boolSchema: DatabaseSchema = {
        flags: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          active: { type: "boolean" },
        },
      };
      const boolDb = await Database.open({ schema: boolSchema });
      try {
        boolDb.sqliteRaw().exec(`
          INSERT INTO "flags" ("active") VALUES (2), (-1), (0), ('true'), ('false'), ('1'), ('0'), (NULL);
        `);
        const rows = (await boolDb.select("flags", {
          orderBy: [{ column: "id", direction: "asc" }],
        })) as { active: unknown }[];
        assert.deepEqual(
          rows.map((r) => r.active),
          [true, true, false, true, false, true, false, null]
        );
      } finally {
        await boolDb.close();
      }
    });
  });
});
