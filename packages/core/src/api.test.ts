import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { createServer } from "./api.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

// ─── Test schema ───────────────────────────────────────────────

const testSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
    email: { type: "text", unique: true },
    age: { type: "integer", nullable: true },
    active: { type: "boolean", default: "1" },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
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
};

// ─── Helpers ───────────────────────────────────────────────────

async function seedUsers(db: Database) {
  await db.insert("users", [
    { name: "Alice", email: "alice@test.com", age: 30 },
    { name: "Bob", email: "bob@test.com", age: 25 },
    { name: "Charlie", email: "charlie@test.com", age: 35 },
  ]);
}

async function parseResponse(res: Response) {
  const json = await res.json();
  return { status: res.status, body: json };
}

// ─── Tests ─────────────────────────────────────────────────────

describe("REST API", () => {
  let db: Database;
  let app: Hono;

  before(async () => {
    db = await Database.open({ schema: testSchema });
    app = createServer(db, testSchema, { auth: { enabled: false } });
    seedUsers(db);
  });

  after(async () => {
    await db.close();
  });

  // ── Health check ──

  describe("GET /", () => {
    it("should return status ok", async () => {
      const res = await app.request("/");
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.status, "ok");
    });
  });

  // ── GET /api/:table — list ──

  describe("GET /api/:table", () => {
    it("should return all rows", async () => {
      const res = await app.request("/api/users");
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.length, 3);
    });

    it("should return 404 for unknown table", async () => {
      const res = await app.request("/api/nonexistent");
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });

    // ── Filtering ──

    it("should filter with eq", async () => {
      const res = await app.request("/api/users?name=eq.Alice");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].name, "Alice");
    });

    it("should filter with neq", async () => {
      const res = await app.request("/api/users?name=neq.Alice");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2);
    });

    it("should filter with gt", async () => {
      const res = await app.request("/api/users?age=gt.28");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2); // Alice(30), Charlie(35)
    });

    it("should filter with lt", async () => {
      const res = await app.request("/api/users?age=lt.30");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 1); // Bob(25)
    });

    it("should filter with gte", async () => {
      const res = await app.request("/api/users?age=gte.30");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2);
    });

    it("should filter with lte", async () => {
      const res = await app.request("/api/users?age=lte.25");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 1); // Bob
    });

    it("should filter with like", async () => {
      const res = await app.request("/api/users?name=like.%25li%25");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2); // Alice, Charlie
    });

    it("should filter with in", async () => {
      const res = await app.request("/api/users?name=in.Alice,Bob");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2);
    });

    it("should combine multiple filters", async () => {
      const res = await app.request("/api/users?age=gte.25&age=lte.30");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2); // Alice(30), Bob(25)
    });

    it("should return 400 for unknown column", async () => {
      const res = await app.request("/api/users?unknown=eq.test");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    it("should return 400 for invalid operator", async () => {
      const res = await app.request("/api/users?name=between.test");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    it("should return 400 for bad filter format", async () => {
      const res = await app.request("/api/users?name=test");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    // ── Sorting ──

    it("should sort ascending", async () => {
      const res = await app.request("/api/users?order=age.asc");
      const { body } = await parseResponse(res);
      assert.equal(body.data[0].name, "Bob");
      assert.equal(body.data[2].name, "Charlie");
    });

    it("should sort descending", async () => {
      const res = await app.request("/api/users?order=age.desc");
      const { body } = await parseResponse(res);
      assert.equal(body.data[0].name, "Charlie");
      assert.equal(body.data[2].name, "Bob");
    });

    it("should sort by multiple columns", async () => {
      const res = await app.request(
        "/api/users?order=age.desc&limit=2"
      );
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2);
    });

    it("should return 400 for invalid sort direction", async () => {
      const res = await app.request("/api/users?order=age.sideways");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    // ── Pagination ──

    it("should limit results", async () => {
      const res = await app.request("/api/users?limit=2");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 2);
    });

    it("should offset results", async () => {
      const res = await app.request("/api/users?limit=2&offset=2");
      const { body } = await parseResponse(res);
      assert.equal(body.data.length, 1);
    });

    it("should return 400 for invalid limit", async () => {
      const res = await app.request("/api/users?limit=abc");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    it("should return 400 for negative limit", async () => {
      const res = await app.request("/api/users?limit=-1");
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    // ── Combined ──

    it("should combine filter, sort, and pagination", async () => {
      const res = await app.request(
        "/api/users?age=gte.25&order=age.desc&limit=2&offset=0"
      );
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0].name, "Charlie");
    });
  });

  // ── GET /api/:table/:id — get one ──

  describe("GET /api/:table/:id", () => {
    it("should return a single row", async () => {
      const res = await app.request("/api/users/1");
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.name, "Alice");
    });

    it("should return 404 for non-existent id", async () => {
      const res = await app.request("/api/users/999");
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });

    it("should return 404 for unknown table", async () => {
      const res = await app.request("/api/nonexistent/1");
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });
  });

  // ── POST /api/:table — insert ──

  describe("POST /api/:table", () => {
    it("should insert a new row", async () => {
      const res = await app.request("/api/users", {
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
      assert.ok(body.data.id);
    });

    it("should reject unknown columns", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: "test@test.com",
          unknown_col: "value",
        }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });

    it("should reject missing required columns", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com" }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 400); // missing "name" which is NOT NULL
    });

    it("should reject duplicate unique values", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Dup",
          email: "alice@test.com",
        }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 409); // SQLite UNIQUE constraint → 409 Conflict
    });

    it("should allow optional columns to be omitted", async () => {
      const res = await app.request("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Minimal",
          email: "minimal@test.com",
        }),
      });
      const { status, body } = await parseResponse(res);
      assert.equal(status, 201);
      assert.equal(body.data.name, "Minimal");
    });

    it("should return 404 for unknown table", async () => {
      const res = await app.request("/api/nonexistent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });
  });

  // ── PATCH /api/:table/:id — update ──

  describe("PATCH /api/:table/:id", () => {
    it("should update an existing row", async () => {
      const res = await app.request("/api/users/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice Updated" }),
      });
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.name, "Alice Updated");
      // Verify it persisted
      const check = await app.request("/api/users/1");
      const checkBody = await check.json();
      assert.equal(checkBody.data.name, "Alice Updated");
    });

    it("should return 404 for non-existent id", async () => {
      const res = await app.request("/api/users/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ghost" }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });

    it("should reject unknown columns", async () => {
      const res = await app.request("/api/users/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unknown_col: "value" }),
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 400);
    });
  });

  // ── DELETE /api/:table/:id — delete ──

  describe("DELETE /api/:table/:id", () => {
    it("should delete an existing row", async () => {
      // First, get current count
      const before = await app.request("/api/users");
      const beforeBody = await before.json();
      const count = beforeBody.data.length;

      const res = await app.request("/api/users/2", {
        method: "DELETE",
      });
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200);
      assert.equal(body.data.deleted, true);

      // Verify count decreased
      const after = await app.request("/api/users");
      const afterBody = await after.json();
      assert.equal(afterBody.data.length, count - 1);
    });

    it("should return 404 for non-existent id", async () => {
      const res = await app.request("/api/users/999", {
        method: "DELETE",
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });

    it("should return 404 for unknown table", async () => {
      const res = await app.request("/api/nonexistent/1", {
        method: "DELETE",
      });
      const { status } = await parseResponse(res);
      assert.equal(status, 404);
    });
  });

  // ── Boolean coercion (body + query filters) ──

  describe("boolean coercion", () => {
    it("accepts JS booleans, string booleans, and 1/0 in POST/PATCH bodies, stores 1/0 on SQLite, and normalizes reads to true/false", async () => {
      const boolSchema: DatabaseSchema = {
        flags: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          name: { type: "text", nullable: false },
          active: { type: "boolean", nullable: false },
        },
      };
      const boolDb = await Database.open({ schema: boolSchema });
      const boolApp = createServer(boolDb, boolSchema, {
        auth: { enabled: false },
      });

      try {
        const resTrue = await boolApp.request("/api/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a", active: true }),
        });
        assert.equal(resTrue.status, 201);
        const bodyTrue = (await resTrue.json()) as { data: { id: number; active: boolean } };
        assert.strictEqual(bodyTrue.data.active, true);
        // Verify SQLite stores 1 underneath
        const rawTrue = boolDb.sqliteRaw().prepare(`SELECT active FROM flags WHERE id = ?`).get(bodyTrue.data.id) as { active: number };
        assert.strictEqual(rawTrue.active, 1);

        const resFalse = await boolApp.request("/api/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "b", active: false }),
        });
        assert.equal(resFalse.status, 201);
        const bodyFalse = (await resFalse.json()) as { data: { id: number; active: boolean } };
        assert.strictEqual(bodyFalse.data.active, false);

        const resPatch = await boolApp.request(`/api/flags/${bodyFalse.data.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: "true" }),
        });
        assert.equal(resPatch.status, 200);
        const bodyPatch = (await resPatch.json()) as { data: { active: boolean } };
        assert.strictEqual(bodyPatch.data.active, true);

        const resBad = await boolApp.request("/api/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "c", active: "maybe" }),
        });
        assert.equal(resBad.status, 400);

        // Query filters: "true", "false", "1", "0"
        const qTrue = await boolApp.request("/api/flags?active=eq.true");
        assert.equal(qTrue.status, 200);
        const qTrueBody = (await qTrue.json()) as { data: { active: boolean }[] };
        assert.equal(qTrueBody.data.length, 2);
        assert.strictEqual(qTrueBody.data[0].active, true);

        const qFalse = await boolApp.request("/api/flags?active=eq.false");
        assert.equal(qFalse.status, 200);
        const qFalseBody = (await qFalse.json()) as { data: unknown[] };
        assert.equal(qFalseBody.data.length, 0);

        const qNum = await boolApp.request("/api/flags?active=eq.1");
        assert.equal(qNum.status, 200);
        const qNumBody = (await qNum.json()) as { data: unknown[] };
        assert.equal(qNumBody.data.length, 2);

        const qBad = await boolApp.request("/api/flags?active=eq.notabool");
        assert.equal(qBad.status, 400);
      } finally {
        await boolDb.close();
      }
    });

    it("rejects non-integer :id path params on integer PK tables with 400", async () => {
      const getRes = await app.request("/api/users/not-a-number");
      assert.equal(getRes.status, 400);

      const patchRes = await app.request("/api/users/not-a-number", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      assert.equal(patchRes.status, 400);

      const delRes = await app.request("/api/users/not-a-number", {
        method: "DELETE",
      });
      assert.equal(delRes.status, 400);
    });
  });
});
