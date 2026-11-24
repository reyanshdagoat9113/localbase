import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database, createServer } from "@localbase/core";
import type { DatabaseSchema } from "@localbase/core";
import { serve } from "@hono/node-server";
import { createClient } from "./client.js";
import type { LocalBaseClient } from "./client.js";

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

let server: ReturnType<typeof serve>;
let db: Database;
let client: LocalBaseClient;

describe("SDK", () => {
  before(async () => {
    db = await Database.open({ schema: testSchema });
    const app = createServer(db, testSchema);

    await db.insert("users", [
      { name: "Alice", email: "alice@test.com", age: 30 },
      { name: "Bob", email: "bob@test.com", age: 25 },
      { name: "Charlie", email: "charlie@test.com", age: 35 },
    ]);

    server = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as { port: number }).port;
    client = createClient(`http://localhost:${port}`);
  });

  after(async () => {
    await db.close();
    server.close();
  });

  describe("select", () => {
    it("should fetch all rows", async () => {
      const { data, error } = await client.from("users").select("*");
      assert.equal(error, null);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 3);
    });

    it("should filter with eq", async () => {
      const { data } = await client.from("users").select("*").eq("name", "Alice");
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 1);
      assert.equal((data as Array<{ name: string }>)[0].name, "Alice");
    });

    it("should filter with neq", async () => {
      const { data } = await client.from("users").select("*").neq("name", "Alice");
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should filter with gt", async () => {
      const { data } = await client.from("users").select("*").gt("age", 28);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should filter with lt", async () => {
      const { data } = await client.from("users").select("*").lt("age", 30);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 1);
    });

    it("should filter with gte", async () => {
      const { data } = await client.from("users").select("*").gte("age", 30);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should filter with lte", async () => {
      const { data } = await client.from("users").select("*").lte("age", 25);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 1);
    });

    it("should filter with like", async () => {
      const { data } = await client.from("users").select("*").like("name", "%li%");
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should filter with in", async () => {
      const { data } = await client.from("users").select("*").in("name", ["Alice", "Bob"]);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should combine multiple filters", async () => {
      const { data } = await client
        .from("users")
        .select("*")
        .gte("age", 25)
        .lte("age", 30);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should sort ascending", async () => {
      const { data } = await client
        .from("users")
        .select("*")
        .order("age", { ascending: true });
      const rows = data as Array<{ name: string }>;
      assert.equal(rows[0].name, "Bob");
      assert.equal(rows[2].name, "Charlie");
    });

    it("should sort descending", async () => {
      const { data } = await client
        .from("users")
        .select("*")
        .order("age", { ascending: false });
      const rows = data as Array<{ name: string }>;
      assert.equal(rows[0].name, "Charlie");
      assert.equal(rows[2].name, "Bob");
    });

    it("should limit results", async () => {
      const { data } = await client.from("users").select("*").limit(2);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 2);
    });

    it("should offset results", async () => {
      const { data } = await client
        .from("users")
        .select("*")
        .limit(2)
        .offset(2);
      assert.ok(Array.isArray(data));
      assert.equal((data as unknown[]).length, 1);
    });

    it("should return single row", async () => {
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("name", "Alice")
        .single();
      assert.equal(error, null);
      assert.ok(!Array.isArray(data));
      assert.equal((data as { name: string }).name, "Alice");
    });

    it("should return null for single with no match", async () => {
      const { data, error } = await client
        .from("users")
        .select("*")
        .eq("name", "NonExistent")
        .single();
      assert.equal(error, null);
      assert.equal(data, null);
    });
  });

  describe("insert", () => {
    it("should insert a row", async () => {
      const { data, error } = await client.from("users").insert({
        name: "Dave",
        email: "dave@test.com",
        age: 28,
      });
      assert.equal(error, null);
      assert.ok(data);
      assert.equal((data as { name: string }).name, "Dave");
      assert.ok((data as { id: number }).id);
    });

    it("should return error for missing required field", async () => {
      const { data, error } = await client.from("users").insert({
        email: "noname@test.com",
      });
      assert.equal(data, null);
      assert.ok(error);
    });

    it("should return error for unknown table", async () => {
      const { data, error } = await client.from("nonexistent").insert({
        name: "Test",
      });
      assert.equal(data, null);
      assert.ok(error);
    });
  });

  describe("update", () => {
    it("should update a row by id", async () => {
      const { data, error } = await client
        .from("users")
        .update({ name: "Alice Updated" })
        .eq("id", 1);
      assert.equal(error, null);
      assert.ok(data);
      assert.equal((data as { name: string }).name, "Alice Updated");
    });

    it("should return error for non-existent id", async () => {
      const { data, error } = await client
        .from("users")
        .update({ name: "Ghost" })
        .eq("id", 9999);
      assert.ok(error);
      assert.equal(data, null);
    });
  });

  describe("delete", () => {
    it("should delete a row by id", async () => {
      const insertResult = await client.from("users").insert({
        name: "ToDelete",
        email: "delete@test.com",
      });
      const id = (insertResult.data as { id: number }).id;

      const { data, error } = await client.from("users").delete().eq("id", id);
      assert.equal(error, null);
      assert.ok(data);
    });

    it("should return error for non-existent id", async () => {
      const { data, error } = await client.from("users").delete().eq("id", 9999);
      assert.ok(error);
      assert.equal(data, null);
    });
  });

  describe("update/delete without an id filter", () => {
    it("update() explains that an id filter is required", async () => {
      const { data, error } = await client
        .from("users")
        .update({ name: "Nope" })
        .eq("email", "alice@test.com");
      assert.equal(data, null);
      assert.match(String(error), /update\(\) requires \.eq\("id", value\)/);
    });

    it("delete() explains that an id filter is required", async () => {
      const { data, error } = await client.from("users").delete().eq("name", "x");
      assert.equal(data, null);
      assert.match(String(error), /delete\(\) requires \.eq\("id", value\)/);
    });

    it("update() rejects additional filters alongside .eq('id', ...)", async () => {
      const { data, error } = await client
        .from("users")
        .update({ name: "Nope" })
        .eq("id", 1)
        .eq("email", "alice@test.com");
      assert.equal(data, null);
      assert.match(String(error), /additional filters are not supported/);
    });

    it("delete() rejects additional filters alongside .eq('id', ...)", async () => {
      const { data, error } = await client
        .from("users")
        .delete()
        .eq("id", 1)
        .eq("name", "Alice");
      assert.equal(data, null);
      assert.match(String(error), /additional filters are not supported/);
    });

    it("URL-encodes the id path segment on update/delete", async () => {
      const origFetch = globalThis.fetch;
      let seenUrl = "";
      globalThis.fetch = (async (input: string | URL | Request) => {
        seenUrl = String(input);
        return new Response(JSON.stringify({ data: { deleted: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      try {
        await client.from("users").delete().eq("id", "a/b c");
        assert.ok(
          seenUrl.endsWith("/api/users/a%2Fb%20c"),
          `expected encoded id, got ${seenUrl}`
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("error handling", () => {
    it("should handle connection refused", async () => {
      const badClient = createClient("http://localhost:1");
      const { data, error } = await badClient.from("users").select("*");
      assert.equal(data, null);
      assert.ok(error);
    });
  });
});
