/**
 * End-to-end test for the full LocalBase flow:
 *   init → dev server → SDK CRUD → cleanup
 *
 * Spins up a real HTTP server on a random port, uses the real SDK,
 * talks to the real Hono API, hits the real SQLite database.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { serve } from "@hono/node-server";
import { Database, createServer } from "@localbase/core";
import { createClient } from "@localbase/sdk";
import type { DatabaseSchema } from "@localbase/shared";

// Schema with FK relationship — closer to a real app
const schema: DatabaseSchema = {
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
    published: { type: "boolean", default: "0" },
  },
};

describe("End-to-end: init → dev → SDK CRUD", () => {
  let tmpDir: string;
  let db: Database;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  before(() => {
    // Simulates what `localbase init` does: create .localbase/ dir + config file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-e2e-"));
    const localbaseDir = path.join(tmpDir, ".localbase");
    fs.mkdirSync(localbaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "localbase.config.ts"),
      "export default { tables: {} };\n"
    );

    // Boot a real database + API server on a random port
    db = new Database({
      path: path.join(localbaseDir, "data.db"),
      schema,
    });

    const app = createServer(db, schema, { auth: { enabled: false } });
    server = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;
  });

  after(() => {
    server.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should perform full CRUD lifecycle via SDK", async () => {
    const client = createClient(baseUrl);

    // ── Create users ──
    const alice = await client.from("users").insert({
      name: "Alice",
      email: "alice@e2e.com",
    });
    assert.equal(alice.error, null);
    assert.equal((alice.data as { name: string }).name, "Alice");
    const aliceId = (alice.data as { id: number }).id;

    const bob = await client.from("users").insert({
      name: "Bob",
      email: "bob@e2e.com",
    });
    const bobId = (bob.data as { id: number }).id;

    // ── Create related posts ──
    const post1 = await client.from("posts").insert({
      title: "Hello World",
      body: "First post",
      user_id: aliceId,
    });
    assert.equal(post1.error, null);

    await client.from("posts").insert({
      title: "Second Post",
      body: "Another one",
      user_id: aliceId,
    });

    await client.from("posts").insert({
      title: "Bob's Post",
      body: "Hi",
      user_id: bobId,
    });

    // ── Select all users ──
    const allUsers = await client.from("users").select("*");
    assert.equal(allUsers.error, null);
    assert.equal((allUsers.data as unknown[]).length, 2);

    // ── Select single user ──
    const single = await client
      .from("users")
      .select("*")
      .eq("id", aliceId)
      .single();
    assert.equal(single.error, null);
    assert.equal((single.data as { name: string }).name, "Alice");

    // ── Filter posts by user_id ──
    const alicePosts = await client
      .from("posts")
      .select("*")
      .eq("user_id", aliceId);
    assert.equal((alicePosts.data as unknown[]).length, 2);

    // ── Filter with IN ──
    const filtered = await client
      .from("posts")
      .select("*")
      .in("user_id", [aliceId, bobId]);
    assert.equal((filtered.data as unknown[]).length, 3);

    // ── Update ──
    const updated = await client
      .from("users")
      .update({ name: "Alice Updated" })
      .eq("id", aliceId);
    assert.equal(updated.error, null);
    assert.equal((updated.data as { name: string }).name, "Alice Updated");

    // ── Order + Limit ──
    const ordered = await client
      .from("users")
      .select("*")
      .order("name", { ascending: true });
    const orderedNames = (ordered.data as Array<{ name: string }>).map(
      (u) => u.name
    );
    assert.deepEqual(orderedNames, ["Alice Updated", "Bob"]);

    // ── Delete ──
    const deleted = await client.from("posts").delete().eq("id", 1);
    assert.equal(deleted.error, null);

    const remaining = await client.from("posts").select("*");
    assert.equal((remaining.data as unknown[]).length, 2);
  });

  it("should reject invalid operations with clean errors", async () => {
    const client = createClient(baseUrl);

    // Unknown table
    const badTable = await client.from("nonexistent").select("*");
    assert.equal(badTable.data, null);
    assert.match(badTable.error!, /Unknown table/);

    // Missing required field
    const missingField = await client.from("users").insert({});
    assert.equal(missingField.data, null);
    assert.match(missingField.error!, /Missing required column/);

    // UNIQUE violation → 409
    await client.from("users").insert({
      name: "Dup",
      email: "unique@e2e.com",
    });
    const dup = await client.from("users").insert({
      name: "Dup",
      email: "unique@e2e.com",
    });
    assert.equal(dup.data, null);
    assert.match(dup.error!, /UNIQUE/i);
  });

  it("should handle connection refused gracefully", async () => {
    const dead = createClient("http://localhost:1");
    const res = await dead.from("users").select("*");
    assert.equal(res.data, null);
    assert.ok(res.error);
  });
});
