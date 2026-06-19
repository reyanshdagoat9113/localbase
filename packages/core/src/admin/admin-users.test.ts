import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import { createAdminRouter } from "./router.js";
import { Auth, resolveAuthConfig } from "../auth/index.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { AuthUser } from "../auth/auth.js";
import type { Hono } from "hono";

// ─── Harness ───────────────────────────────────────────────────
//
// The user endpoints are only mounted when the Auth subsystem is wired in, and
// gated by requireAdmin. So every test here uses auth + admin enabled and mints
// tokens through the real /api/auth/* stack (first signup = admin bootstrap).

const SECRET = "m5-test-secret-please-do-not-use-in-prod";

const testSchema: DatabaseSchema = {
  tasks: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    done: { type: "boolean", default: "0" },
  },
};

function newApp(): { db: Database; app: Hono } {
  const db = new Database({
    schema: testSchema,
    auth: { enabled: true, jwtSecret: SECRET },
  });
  const app = createServer(db, testSchema, {
    auth: { enabled: true, jwtSecret: SECRET },
    admin: { enabled: true },
  });
  return { db, app };
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

async function signup(
  app: Hono,
  email: string,
  password = "password123"
): Promise<{ user: AuthUser; accessToken: string }> {
  const res = await app.request(
    "/api/auth/signup",
    jsonReq("POST", { email, password })
  );
  const body = await res.json();
  return body.data;
}

async function parse(res: Response) {
  const body = await res.json();
  return { status: res.status, body };
}

// ─── GET /_api/admin/users ──────────────────────────────────────

describe("GET /_api/admin/users", () => {
  const { db, app } = newApp();
  after(() => db.close());

  it("lists users for an admin token (no password hashes)", async () => {
    const admin = await signup(app, "admin@test.com"); // first → admin
    await signup(app, "bob@test.com");

    const res = await app.request("/_api/admin/users", {
      headers: bearer(admin.accessToken),
    });
    const { status, body } = await parse(res);
    assert.equal(status, 200);
    assert.equal(body.data.length, 2);
    assert.deepEqual(
      body.data.map((u: AuthUser) => u.email),
      ["admin@test.com", "bob@test.com"]
    );
    // Password hashes must never leak.
    for (const u of body.data) {
      assert.equal("password_hash" in u, false);
    }
  });

  it("rejects a non-admin token with 403", async () => {
    await signup(app, "carol@test.com"); // role=user
    const res = await app.request("/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "carol@test.com", password: "password123" }),
    });
    const session = (await res.json()).data;

    const usersRes = await app.request("/_api/admin/users", {
      headers: bearer(session.accessToken),
    });
    assert.equal(usersRes.status, 403);
  });

  it("rejects a missing token with 401", async () => {
    const res = await app.request("/_api/admin/users");
    assert.equal(res.status, 401);
  });
});

// ─── POST /_api/admin/users ────────────────────────────────────

describe("POST /_api/admin/users", () => {
  const { db, app } = newApp();
  let admin: { accessToken: string };
  after(() => db.close());

  it("creates a user as role=user and surfaces them in the list", async () => {
    admin = (await signup(app, "admin@test.com")) as { accessToken: string };

    const res = await app.request(
      "/_api/admin/users",
      jsonReq(
        "POST",
        { email: "new@test.com", password: "supersecret1" },
        bearer(admin.accessToken)
      )
    );
    const { status, body } = await parse(res);
    assert.equal(status, 201);
    assert.equal(body.data.email, "new@test.com");
    assert.equal(body.data.role, "user");

    const list = await app.request("/_api/admin/users", {
      headers: bearer(admin.accessToken),
    });
    const listBody = await list.json();
    assert.ok(
      listBody.data.some((u: AuthUser) => u.email === "new@test.com")
    );
  });

  it("returns 409 on a duplicate email", async () => {
    const res = await app.request(
      "/_api/admin/users",
      jsonReq(
        "POST",
        { email: "new@test.com", password: "supersecret1" },
        bearer(admin.accessToken)
      )
    );
    assert.equal(res.status, 409);
  });

  it("returns 400 when the password is missing", async () => {
    const res = await app.request(
      "/_api/admin/users",
      jsonReq(
        "POST",
        { email: "nopw@test.com" },
        bearer(admin.accessToken)
      )
    );
    assert.equal(res.status, 400);
  });

  it("returns 400 for an invalid email", async () => {
    const res = await app.request(
      "/_api/admin/users",
      jsonReq("POST", { email: "not-an-email", password: "supersecret1" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 400);
  });

  it("rejects a non-admin token with 403", async () => {
    const user = await signup(app, "normie@test.com"); // role=user
    const res = await app.request(
      "/_api/admin/users",
      jsonReq("POST", { email: "x@test.com", password: "supersecret1" }, bearer(user.accessToken))
    );
    assert.equal(res.status, 403);
  });
});

// ─── POST /_api/admin/users/:id/reset-password ─────────────────

describe("POST /_api/admin/users/:id/reset-password", () => {
  const { db, app } = newApp();
  let admin: { accessToken: string };
  let target: AuthUser;
  after(() => db.close());

  it("resets the password (old fails, new works)", async () => {
    admin = (await signup(app, "admin@test.com")) as { accessToken: string };
    const created = await app.request(
      "/_api/admin/users",
      jsonReq("POST", { email: "victim@test.com", password: "oldpassword1" }, bearer(admin.accessToken))
    );
    target = (await created.json()).data;

    const res = await app.request(
      `/_api/admin/users/${target.id}/reset-password`,
      jsonReq("POST", { password: "brandnew1" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 200);

    // Old password no longer works.
    const oldRes = await app.request(
      "/api/auth/signin",
      jsonReq("POST", { email: "victim@test.com", password: "oldpassword1" })
    );
    assert.equal(oldRes.status, 401);

    // New password works.
    const newRes = await app.request(
      "/api/auth/signin",
      jsonReq("POST", { email: "victim@test.com", password: "brandnew1" })
    );
    assert.equal(newRes.status, 200);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.request(
      "/_api/admin/users/9999/reset-password",
      jsonReq("POST", { password: "whatever1" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 404);
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await app.request(
      "/_api/admin/users/abc/reset-password",
      jsonReq("POST", { password: "whatever1" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 400);
  });

  it("returns 400 when the password is too short", async () => {
    const res = await app.request(
      `/_api/admin/users/${target.id}/reset-password`,
      jsonReq("POST", { password: "short" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 400);
  });
});

// ─── PATCH /_api/admin/users/:id/role ──────────────────────────

describe("PATCH /_api/admin/users/:id/role", () => {
  const { db, app } = newApp();
  let admin: { accessToken: string };
  after(() => db.close());

  it("promotes a user to admin", async () => {
    admin = (await signup(app, "admin@test.com")) as { accessToken: string };
    const created = await app.request(
      "/_api/admin/users",
      jsonReq("POST", { email: "promotee@test.com", password: "supersecret1" }, bearer(admin.accessToken))
    );
    const user = (await created.json()).data;

    const res = await app.request(
      `/_api/admin/users/${user.id}/role`,
      jsonReq("PATCH", { role: "admin" }, bearer(admin.accessToken))
    );
    const { status, body } = await parse(res);
    assert.equal(status, 200);
    assert.equal(body.data.role, "admin");
  });

  it("demotes an admin when others remain", async () => {
    // admin@test.com (admin) + promotee@test.com (now admin from above) → 2 admins.
    const created = await app.request(
      "/_api/admin/users",
      jsonReq("POST", { email: "demotee@test.com", password: "supersecret1" }, bearer(admin.accessToken))
    );
    const user = (await created.json()).data;
    await app.request(
      `/_api/admin/users/${user.id}/role`,
      jsonReq("PATCH", { role: "admin" }, bearer(admin.accessToken))
    );

    const res = await app.request(
      `/_api/admin/users/${user.id}/role`,
      jsonReq("PATCH", { role: "user" }, bearer(admin.accessToken))
    );
    const { status, body } = await parse(res);
    assert.equal(status, 200);
    assert.equal(body.data.role, "user");
  });

  it("refuses to demote the last admin (409)", async () => {
    // Fresh DB with a single admin.
    const { app: app2, db: db2 } = newApp();
    try {
      const only = await signup(app2, "solo@test.com"); // first → admin, only admin
      const list = await app2.request("/_api/admin/users", {
        headers: bearer(only.accessToken),
      });
      const soloUser = (await list.json()).data[0];

      const res = await app2.request(
        `/_api/admin/users/${soloUser.id}/role`,
        jsonReq("PATCH", { role: "user" }, bearer(only.accessToken))
      );
      const { status, body } = await parse(res);
      assert.equal(status, 409);
      assert.match(body.error, /last admin/i);
    } finally {
      db2.close();
    }
  });

  it("returns 400 for an invalid role", async () => {
    const list = await app.request("/_api/admin/users", {
      headers: bearer(admin.accessToken),
    });
    const someUser = (await list.json()).data[0];
    const res = await app.request(
      `/_api/admin/users/${someUser.id}/role`,
      jsonReq("PATCH", { role: "superuser" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 400);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.request(
      "/_api/admin/users/9999/role",
      jsonReq("PATCH", { role: "admin" }, bearer(admin.accessToken))
    );
    assert.equal(res.status, 404);
  });

  it("rejects a non-admin token with 403", async () => {
    const normie = await signup(app, "outsider@test.com"); // role=user
    const res = await app.request(
      "/_api/admin/users/1/role",
      jsonReq("PATCH", { role: "admin" }, bearer(normie.accessToken))
    );
    assert.equal(res.status, 403);
  });
});

// ─── Not mounted when auth is disabled ─────────────────────────

describe("user endpoints are gated on auth being enabled", () => {
  it("refuses to construct Auth Manager routes without requireAdmin", () => {
    const db = new Database({
      schema: testSchema,
      auth: { enabled: true, jwtSecret: SECRET },
    });
    try {
      const { config } = resolveAuthConfig({ enabled: true, jwtSecret: SECRET });
      const auth = new Auth(db, config);
      assert.throws(
        () => createAdminRouter(db, { auth }),
        /require admin auth/i
      );
    } finally {
      db.close();
    }
  });

  it("GET /_api/admin/users returns 404 when auth is disabled", async () => {
    const db = new Database({ schema: testSchema });
    try {
      // admin enabled but no auth → no Auth instance → user routes not mounted.
      const app = createServer(db, testSchema, { admin: { enabled: true } });
      const res = await app.request("/_api/admin/users");
      assert.equal(res.status, 404);
    } finally {
      db.close();
    }
  });
});
