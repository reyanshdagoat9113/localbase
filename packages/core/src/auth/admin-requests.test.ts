import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Hono } from "hono";
import type { DatabaseSchema } from "@localbase/shared";
import { Database } from "../db.js";
import { createServer } from "../api.js";

const SECRET = "admin-request-test-secret";
const schema: DatabaseSchema = {
  notes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    body: { type: "text", nullable: false },
  },
};

const databases: Database[] = [];

async function app(): Promise<Hono> {
  const db = await Database.open({
    schema,
    auth: { enabled: true, jwtSecret: SECRET },
  });
  databases.push(db);
  return createServer(db, schema, {
    auth: { enabled: true, jwtSecret: SECRET },
    admin: { enabled: true },
  });
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function json(method: string, body: unknown, token?: string) {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function owner(server: Hono) {
  const res = await server.request(
    "/api/auth/owner",
    json("POST", { email: "owner@test.com", password: "password123" })
  );
  assert.equal(res.status, 201);
  return (await res.json()).data;
}

async function requestAdmin(
  server: Hono,
  email = "admin@test.com",
  password = "adminpassword123"
) {
  return server.request(
    "/api/auth/admin-requests",
    json("POST", { email, password })
  );
}

describe("admin account approval workflow", () => {
  it("reports whether the owner has been created", async () => {
    const server = await app();
    let res = await server.request("/api/auth/admin-registration");
    assert.deepEqual(await res.json(), { data: { ownerExists: false } });

    await owner(server);
    res = await server.request("/api/auth/admin-registration");
    assert.deepEqual(await res.json(), { data: { ownerExists: true } });
  });

  it("refuses a second owner bootstrap without creating a regular user", async () => {
    const server = await app();
    await owner(server);
    const res = await server.request(
      "/api/auth/owner",
      json("POST", { email: "second@test.com", password: "password123" })
    );
    assert.equal(res.status, 409);

    const signin = await server.request(
      "/api/auth/signin",
      json("POST", { email: "second@test.com", password: "password123" })
    );
    assert.equal(signin.status, 401);
  });

  it("stores a pending request without exposing its password hash", async () => {
    const server = await app();
    const ownerSession = await owner(server);
    const created = await requestAdmin(server);
    assert.equal(created.status, 202);
    assert.equal((await created.json()).data.email, "admin@test.com");

    const list = await server.request(
      "/_api/admin/admin-requests?limit=10&offset=0",
      { headers: { Authorization: `Bearer ${ownerSession.accessToken}` } }
    );
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.data.total, 1);
    assert.equal(body.data.requests[0].email, "admin@test.com");
    assert.equal("password_hash" in body.data.requests[0], false);

    const tables = await server.request("/_api/admin/tables", {
      headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
    });
    assert.equal(
      (await tables.json()).data.some(
        (table: { name: string }) => table.name === "_admin_requests"
      ),
      false
    );
    const schema = await server.request("/_api/admin/schema", {
      headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
    });
    assert.equal(
      (await schema.json()).data.tables.some(
        (table: { name: string }) => table.name === "_admin_requests"
      ),
      false
    );
  });

  it("owner approval creates an admin who can sign in", async () => {
    const server = await app();
    const ownerSession = await owner(server);
    const request = await requestAdmin(server);
    const requestId = (await request.json()).data.id;

    const approved = await server.request(
      `/_api/admin/admin-requests/${requestId}/approve`,
      json("POST", {}, ownerSession.accessToken)
    );
    assert.equal(approved.status, 201);
    assert.equal((await approved.json()).data.role, "admin");

    const signin = await server.request(
      "/api/auth/signin",
      json("POST", {
        email: "admin@test.com",
        password: "adminpassword123",
      })
    );
    assert.equal(signin.status, 200);
    assert.equal((await signin.json()).data.user.role, "admin");
  });

  it("promotes an existing user after verifying their password", async () => {
    const server = await app();
    const ownerSession = await owner(server);
    const signup = await server.request(
      "/api/auth/signup",
      json("POST", {
        email: "user@test.com",
        password: "userpassword123",
      })
    );
    assert.equal((await signup.json()).data.user.role, "user");

    const wrongPassword = await requestAdmin(
      server,
      "user@test.com",
      "wrongpassword123"
    );
    assert.equal(wrongPassword.status, 401);

    const requested = await requestAdmin(
      server,
      "user@test.com",
      "userpassword123"
    );
    assert.equal(requested.status, 202);
    const request = (await requested.json()).data;
    assert.equal(request.kind, "promote");

    const approved = await server.request(
      `/_api/admin/admin-requests/${request.id}/approve`,
      json("POST", {}, ownerSession.accessToken)
    );
    assert.equal(approved.status, 201);
    assert.equal((await approved.json()).data.role, "admin");

    const signin = await server.request(
      "/api/auth/signin",
      json("POST", {
        email: "user@test.com",
        password: "userpassword123",
      })
    );
    assert.equal(signin.status, 200);
    assert.equal((await signin.json()).data.user.role, "admin");
  });

  it("regular admins cannot list, approve, or reject requests", async () => {
    const server = await app();
    const ownerSession = await owner(server);
    const first = await requestAdmin(server, "existing-admin@test.com");
    const firstId = (await first.json()).data.id;
    await server.request(
      `/_api/admin/admin-requests/${firstId}/approve`,
      json("POST", {}, ownerSession.accessToken)
    );
    const signin = await server.request(
      "/api/auth/signin",
      json("POST", {
        email: "existing-admin@test.com",
        password: "adminpassword123",
      })
    );
    const adminToken = (await signin.json()).data.accessToken;
    const pending = await requestAdmin(server, "pending@test.com");
    const pendingId = (await pending.json()).data.id;

    const list = await server.request("/_api/admin/admin-requests", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(list.status, 403);
    const approve = await server.request(
      `/_api/admin/admin-requests/${pendingId}/approve`,
      json("POST", {}, adminToken)
    );
    assert.equal(approve.status, 403);
    const reject = await server.request(
      `/_api/admin/admin-requests/${pendingId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(reject.status, 403);
    const rawRows = await server.request(
      "/_api/admin/tables/_admin_requests/rows",
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    assert.equal(rawRows.status, 403);
  });

  it("owner rejection removes the request without creating an account", async () => {
    const server = await app();
    const ownerSession = await owner(server);
    const pending = await requestAdmin(server);
    const pendingId = (await pending.json()).data.id;
    const rejected = await server.request(
      `/_api/admin/admin-requests/${pendingId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${ownerSession.accessToken}` } }
    );
    assert.equal(rejected.status, 200);

    const signin = await server.request(
      "/api/auth/signin",
      json("POST", {
        email: "admin@test.com",
        password: "adminpassword123",
      })
    );
    assert.equal(signin.status, 401);
  });

  it("rejects requests before owner setup and duplicate pending emails", async () => {
    const server = await app();
    assert.equal((await requestAdmin(server)).status, 409);
    await owner(server);
    assert.equal((await requestAdmin(server)).status, 202);
    assert.equal((await requestAdmin(server)).status, 409);
  });
});
