/**
 * Row-Level Security tests.
 *
 * Covers the public REST API (`/api/:table`) behavior when a table has an owner
 * policy: insert stamps the owner, reads/writes are scoped to the owner, and
 * tables without a policy stay open. Uses signed access tokens directly — RLS
 * consumes the token's `sub` (user id) and uses live `_users.role` only for
 * `adminBypass`, so the tests seed minimal users and sign tokens directly.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { createServer } from "./api.js";
import { signAccessToken } from "./auth/index.js";
import { resolvePolicies } from "./rls.js";
import type { DatabaseSchema, PoliciesConfig } from "@localbase/shared";
import type { Hono } from "hono";

const SECRET = "test-secret-key-32-bytes-or-longer";

const authConfig = {
  enabled: true,
  jwtSecret: SECRET,
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
};

const schema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    owner_id: { type: "integer" },
  },
  // A table with NO policy — must stay open to anonymous requests (back-compat).
  tags: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};

interface Row {
  id: number;
  title: string;
  owner_id: number | null;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonReq(
  method: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function readJson(res: Response) {
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** Build a fresh in-memory server + tokens for two users (alice=admin, bob=user). */
async function setup(policies?: PoliciesConfig): Promise<{
  db: Database;
  app: Hono;
  aliceToken: string;
  bobToken: string;
}> {
  const db = await Database.open({ schema, auth: authConfig });
  seedAuthUsers(db);
  const app = createServer(db, schema, { auth: authConfig, policies });
  const aliceToken = await signAccessToken(
    { id: 1, email: "alice@x.com", role: "admin" },
    SECRET,
    "1h"
  );
  const bobToken = await signAccessToken(
    { id: 2, email: "bob@x.com", role: "user" },
    SECRET,
    "1h"
  );
  return { db, app, aliceToken, bobToken };
}

function seedAuthUsers(db: Database): void {
  const insert = db.sqliteRaw().prepare(
    `INSERT INTO "_users" ("id", "email", "password_hash", "role") VALUES (?, ?, ?, ?)`
  );
  insert.run(1, "alice@x.com", "unused", "admin");
  insert.run(2, "bob@x.com", "unused", "user");
}

const POLICY: PoliciesConfig = { posts: { ownerColumn: "owner_id" } };

// ─── insert stamps owner ───────────────────────────────────────

describe("RLS insert", () => {
  let db: Database;
  let app: Hono;
  let aliceToken: string;

  before(async () => {
    ({ db, app, aliceToken } = await setup(POLICY));
  });
  after(async () => await db.close());

  it("stamps the authenticated user's id as owner", async () => {
    const res = await app.request(
      "/api/posts",
      jsonReq("POST", { title: "alice post" }, bearer(aliceToken))
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 201);
    assert.equal((body.data as Row).owner_id, 1);
  });

  it("overrides a client-supplied owner (cannot write as another user)", async () => {
    const res = await app.request(
      "/api/posts",
      jsonReq("POST", { title: "forged", owner_id: 999 }, bearer(aliceToken))
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 201);
    assert.equal((body.data as Row).owner_id, 1);
  });

  it("rejects anonymous inserts on a policy'd table (401)", async () => {
    const res = await app.request("/api/posts", jsonReq("POST", { title: "anon" }));
    assert.equal(res.status, 401);
  });
});

// ─── read scoping ──────────────────────────────────────────────

describe("RLS read scoping", () => {
  let db: Database;
  let app: Hono;
  let aliceToken: string;
  let bobToken: string;

  before(async () => {
    ({ db, app, aliceToken, bobToken } = await setup(POLICY));
    // alice owns two posts, bob owns one.
    await app.request("/api/posts", jsonReq("POST", { title: "a1" }, bearer(aliceToken)));
    await app.request("/api/posts", jsonReq("POST", { title: "a2" }, bearer(aliceToken)));
    await app.request("/api/posts", jsonReq("POST", { title: "b1" }, bearer(bobToken)));
  });
  after(async () => await db.close());

  it("lists only the caller's rows (admins are scoped too)", async () => {
    const aliceRes = await app.request("/api/posts", { headers: bearer(aliceToken) });
    const alice = await readJson(aliceRes);
    assert.equal(alice.status, 200);
    assert.equal((alice.body.data as Row[]).length, 2);

    const bobRes = await app.request("/api/posts", { headers: bearer(bobToken) });
    const bob = await readJson(bobRes);
    assert.equal((bob.body.data as Row[]).length, 1);
    assert.equal((bob.body.data as Row[])[0].title, "b1");
  });

  it("returns 404 for another user's row by id (no existence leak)", async () => {
    // bob (id 2) tries to read alice's first post (id 1).
    const res = await app.request("/api/posts/1", { headers: bearer(bobToken) });
    assert.equal(res.status, 404);
  });

  it("returns the row for the owner by id", async () => {
    const res = await app.request("/api/posts/1", { headers: bearer(aliceToken) });
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.equal((body.data as Row).title, "a1");
  });

  it("rejects anonymous reads on a policy'd table (401)", async () => {
    const res = await app.request("/api/posts");
    assert.equal(res.status, 401);
  });
});

// ─── write scoping (update / delete) ───────────────────────────

describe("RLS write scoping", () => {
  let db: Database;
  let app: Hono;
  let aliceToken: string;
  let bobToken: string;

  before(async () => {
    ({ db, app, aliceToken, bobToken } = await setup(POLICY));
    await app.request("/api/posts", jsonReq("POST", { title: "a1" }, bearer(aliceToken)));
    await app.request("/api/posts", jsonReq("POST", { title: "b1" }, bearer(bobToken)));
  });
  after(async () => await db.close());

  it("forbids updating another user's row (404)", async () => {
    // bob tries to patch alice's post (id 1).
    const res = await app.request(
      "/api/posts/1",
      jsonReq("PATCH", { title: "hacked" }, bearer(bobToken))
    );
    assert.equal(res.status, 404);
    // unchanged
    const check = await readJson(await app.request("/api/posts/1", { headers: bearer(aliceToken) }));
    assert.equal((check.body.data as Row).title, "a1");
  });

  it("ignores attempts to reassign ownership on update", async () => {
    // bob owns post 2; tries to transfer it to alice (id 1).
    const res = await app.request(
      "/api/posts/2",
      jsonReq("PATCH", { owner_id: 1 }, bearer(bobToken))
    );
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.equal((body.data as Row).owner_id, 2); // still bob's
  });

  it("forbids deleting another user's row (404)", async () => {
    const res = await app.request("/api/posts/1", {
      method: "DELETE",
      headers: bearer(bobToken),
    });
    assert.equal(res.status, 404);
  });

  it("lets the owner delete their own row", async () => {
    const res = await app.request("/api/posts/1", {
      method: "DELETE",
      headers: bearer(aliceToken),
    });
    assert.equal(res.status, 200);
  });
});

// ─── non-policy tables stay open ───────────────────────────────

describe("RLS does not affect non-policy tables", () => {
  let db: Database;
  let app: Hono;

  before(async () => {
    ({ db, app } = await setup(POLICY)); // only `posts` has a policy
  });
  after(async () => await db.close());

  it("allows anonymous list on a table without a policy", async () => {
    const res = await app.request("/api/tags");
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.deepEqual(body.data, []);
  });

  it("allows anonymous insert on a table without a policy", async () => {
    const res = await app.request("/api/tags", jsonReq("POST", { name: "open" }));
    assert.equal(res.status, 201);
  });
});

// ─── adminBypass opt-in ────────────────────────────────────────

describe("RLS adminBypass", () => {
  let db: Database;
  let app: Hono;
  let aliceToken: string;
  let bobToken: string;

  before(async () => {
    ({ db, app, aliceToken, bobToken } = await setup({
      posts: { ownerColumn: "owner_id", adminBypass: true },
    }));
    // bob owns a post (alice, bypassed, doesn't get an auto-stamp, so set hers explicitly).
    await app.request(
      "/api/posts",
      jsonReq("POST", { title: "a1", owner_id: 1 }, bearer(aliceToken))
    );
    await app.request("/api/posts", jsonReq("POST", { title: "b1" }, bearer(bobToken)));
  });
  after(async () => await db.close());

  it("lets an admin read rows they don't own", async () => {
    // bob's post is id 2. With adminBypass, alice can fetch it directly.
    const res = await app.request("/api/posts/2", { headers: bearer(aliceToken) });
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.equal((body.data as Row).title, "b1");
  });

  it("lets an admin list every row (bypasses the owner filter)", async () => {
    const res = await app.request("/api/posts", { headers: bearer(aliceToken) });
    const { body } = await readJson(res);
    assert.equal((body.data as Row[]).length, 2);
  });

  it("still scopes non-admin users", async () => {
    const res = await app.request("/api/posts", { headers: bearer(bobToken) });
    const { body } = await readJson(res);
    assert.equal((body.data as Row[]).length, 1);
  });
});

describe("RLS adminBypass uses live roles", () => {
  let db: Database;
  let app: Hono;
  let aliceToken: string;
  let bobToken: string;

  before(async () => {
    ({ db, app, aliceToken, bobToken } = await setup({
      posts: { ownerColumn: "owner_id", adminBypass: true },
    }));
    await app.request(
      "/api/posts",
      jsonReq("POST", { title: "a1", owner_id: 1 }, bearer(aliceToken))
    );
    await app.request("/api/posts", jsonReq("POST", { title: "b1" }, bearer(bobToken)));
  });
  after(async () => await db.close());

  it("does not bypass with a stale admin token after demotion", async () => {
    db.sqliteRaw().prepare(`UPDATE "_users" SET "role" = 'user' WHERE "id" = 1`).run();

    const list = await readJson(
      await app.request("/api/posts", { headers: bearer(aliceToken) })
    );
    assert.equal(list.status, 200);
    assert.deepEqual(
      (list.body.data as Row[]).map((row) => row.title),
      ["a1"]
    );

    const bobRow = await app.request("/api/posts/2", { headers: bearer(aliceToken) });
    assert.equal(bobRow.status, 404);
  });
});

// ─── config resolution ─────────────────────────────────────────

describe("resolvePolicies", () => {
  it("returns an empty map when no policies are declared", () => {
    assert.equal(resolvePolicies(undefined, schema).size, 0);
  });

  it("resolves a valid policy with adminBypass defaulting to false", () => {
    const m = resolvePolicies({ posts: { ownerColumn: "owner_id" } }, schema);
    assert.deepEqual(m.get("posts"), {
      table: "posts",
      ownerColumn: "owner_id",
      adminBypass: false,
    });
  });

  it("accepts adminBypass: true", () => {
    const m = resolvePolicies(
      { posts: { ownerColumn: "owner_id", adminBypass: true } },
      schema
    );
    assert.equal(m.get("posts")!.adminBypass, true);
  });

  it("throws on an unknown table", () => {
    assert.throws(
      () => resolvePolicies({ nope: { ownerColumn: "owner_id" } }, schema),
      /unknown table "nope"/
    );
  });

  it("throws on an unknown owner column", () => {
    assert.throws(
      () => resolvePolicies({ posts: { ownerColumn: "missing" } }, schema),
      /unknown column "missing"/
    );
  });
});

// ─── policies require auth ─────────────────────────────────────

describe("policies require auth", () => {
  it("createServer throws when policies are set but auth is explicitly disabled", async () => {
    const db = await Database.open({ schema });
    assert.throws(
      () =>
        createServer(db, schema, {
          auth: { enabled: false },
          policies: POLICY,
        }),
      /auth/i
    );
    await db.close();
  });

  it("policies alone are fine — auth is on by default", async () => {
    const db = await Database.open({ schema });
    const app = createServer(db, schema, { policies: POLICY });
    // The policy'd table demands a token even though no auth config was given.
    const res = await app.request("/api/posts");
    assert.equal(res.status, 401);
    await db.close();
  });
});
