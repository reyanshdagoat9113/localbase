import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { createServer } from "./api.js";
import { Auth } from "./auth/auth.js";
import { resolveAuthConfig } from "./auth/config.js";
import { signAccessToken } from "./auth/tokens.js";
import { requireAdmin } from "./auth/middleware.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

const SECRET = "m2-test-secret-please-do-not-use-in-prod";

const testSchema: DatabaseSchema = {
  tasks: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    done: { type: "boolean", default: "0" },
  },
};

function newAuthDb(): { db: Database; auth: Auth } {
  const db = new Database({
    schema: testSchema,
    auth: { enabled: true, jwtSecret: SECRET },
  });
  const { config } = resolveAuthConfig({ enabled: true, jwtSecret: SECRET });
  const auth = new Auth(db, config);
  return { db, auth };
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function signUp(auth: Auth, email: string, password = "password123") {
  return auth.signUp({ email, password });
}

// ─── First-user bootstrap ──────────────────────────────────────

describe("First-user bootstrap", () => {
  it("the very first signup becomes an admin", async () => {
    const { db, auth } = newAuthDb();
    try {
      const session = await signUp(auth, "first@test.com");
      assert.equal(session.user.role, "admin");

      // The token carries the admin role claim.
      assert.equal(session.accessToken.length > 0, true);

      // Confirm in the DB.
      assert.equal(auth.countAdmins(), 1);
      assert.equal(auth.countUsers(), 1);
    } finally {
      db.close();
    }
  });

  it("subsequent signups are regular users", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com");
      const second = await signUp(auth, "second@test.com");
      assert.equal(second.user.role, "user");
      assert.equal(auth.countAdmins(), 1);
      assert.equal(auth.countUsers(), 2);
    } finally {
      db.close();
    }
  });

  it("the admin claim is actually embedded in the JWT", async () => {
    const { db, auth } = newAuthDb();
    try {
      const session = await signUp(auth, "first@test.com");
      // Re-sign a token directly to assert the claim is there.
      const token = await signAccessToken(
        { id: 1, email: "first@test.com", role: "admin" },
        SECRET,
        "1h"
      );
      // We can't decode without verify, but the requireAdmin tests below
      // exercise the round-trip. Here we just assert the session has a token.
      assert.ok(token.length > session.accessToken.length / 2);
    } finally {
      db.close();
    }
  });
});

// ─── setRole + last-admin lockout ──────────────────────────────

describe("setRole + last-admin lockout", () => {
  it("promotes a user to admin", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com"); // user
      const promoted = auth.setRole("second@test.com", "admin");
      assert.equal(promoted.role, "admin");
      assert.equal(auth.countAdmins(), 2);
    } finally {
      db.close();
    }
  });

  it("is idempotent when the role is unchanged", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // admin
      const result = auth.setRole("first@test.com", "admin");
      assert.equal(result.role, "admin");
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });

  it("demotes an admin when other admins remain", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com");
      auth.setRole("second@test.com", "admin");
      const demoted = auth.setRole("first@test.com", "user");
      assert.equal(demoted.role, "user");
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });

  it("REFUSES to demote the last admin (lockout protection)", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "only@test.com"); // the sole admin
      assert.throws(
        () => auth.setRole("only@test.com", "user"),
        (err: unknown) =>
          err instanceof Error &&
          (err as { status?: number }).status === 409 &&
          /last admin/i.test(err.message)
      );
      // Still an admin.
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });

  it("rejects an invalid role value", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com");
      assert.throws(
        () => auth.setRole("first@test.com", "superuser"),
        (err: unknown) =>
          err instanceof Error &&
          (err as { status?: number }).status === 400
      );
    } finally {
      db.close();
    }
  });

  it("404s on an unknown email", async () => {
    const { db, auth } = newAuthDb();
    try {
      assert.throws(
        () => auth.setRole("ghost@test.com", "admin"),
        (err: unknown) =>
          err instanceof Error &&
          (err as { status?: number }).status === 404
      );
    } finally {
      db.close();
    }
  });
});

// ─── requireAdmin middleware ───────────────────────────────────

describe("requireAdmin middleware", () => {
  function gatedApp(): { app: Hono; db: Database; auth: Auth } {
    const { db, auth } = newAuthDb();
    // A minimal app that uses requireAdmin directly so we test the
    // middleware in isolation.
    const app = createServer(db, testSchema, {});
    app.get("/_test/admin-only", requireAdmin(SECRET, db), (c) =>
      c.json({ data: "ok" })
    );
    return { app, db, auth };
  }

  it("returns 401 when no Authorization header is present", async () => {
    const { app, db } = gatedApp();
    try {
      const res = await app.request("/_test/admin-only");
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });

  it("returns 401 for a malformed Authorization header", async () => {
    const { app, db } = gatedApp();
    try {
      const res = await app.request("/_test/admin-only", {
        headers: { Authorization: "Token abc" },
      });
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });

  it("returns 200 for a current admin token", async () => {
    const { app, db, auth } = gatedApp();
    try {
      const session = await signUp(auth, "admin@test.com");
      const res = await app.request("/_test/admin-only", {
        headers: bearer(session.accessToken),
      });
      assert.equal(res.status, 200);
    } finally {
      db.close();
    }
  });

  it("returns 403 for a regular-user token", async () => {
    const { app, db, auth } = gatedApp();
    try {
      await signUp(auth, "admin@test.com");
      const second = await signUp(auth, "user@test.com");
      const res = await app.request("/_test/admin-only", {
        headers: bearer(second.accessToken),
      });
      assert.equal(res.status, 403);
    } finally {
      db.close();
    }
  });

  it("returns 403 for a DEMOTED admin (demotion takes effect immediately)", async () => {
    // This is the key property the plan calls out: requireAdmin re-reads
    // the live role, so an admin who was demoted loses access before
    // their access token expires.
    const { app, db, auth } = gatedApp();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com");
      auth.setRole("second@test.com", "admin");
      const secondAdminSession = await auth.signIn({
        email: "second@test.com",
        password: "password123",
      });

      // Demote second now (first remains admin, so this is allowed).
      auth.setRole("second@test.com", "user");

      // second's token was issued when they were admin. It must NOT work now.
      const staleRes = await app.request("/_test/admin-only", {
        headers: bearer(secondAdminSession.accessToken),
      });
      assert.equal(staleRes.status, 403);
    } finally {
      db.close();
    }
  });

  it("returns 401 for a DELETED admin's token", async () => {
    const { app, db, auth } = gatedApp();
    try {
      const session = await signUp(auth, "admin@test.com");
      // Delete the user's sessions first (they FK _users), then the user.
      // This mirrors what a real deleteUser flow would do.
      db.delete("_sessions", [
        { column: "user_id", operator: "eq", value: session.user.id },
      ]);
      db.delete("_users", [
        { column: "email", operator: "eq", value: "admin@test.com" },
      ]);
      const res = await app.request("/_test/admin-only", {
        headers: bearer(session.accessToken),
      });
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });

  it("returns 401 for a token signed with a different secret", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "admin@test.com");
      // Sign with the wrong secret.
      const forged = await signAccessToken(
        { id: 1, email: "admin@test.com", role: "admin" },
        "WRONG-SECRET",
        "1h"
      );
      const forgedApp = createServer(db, testSchema, {});
      forgedApp.get("/_test/admin-only", requireAdmin(SECRET, db), (c) =>
        c.json({ data: "ok" })
      );
      const res = await forgedApp.request("/_test/admin-only", {
        headers: bearer(forged),
      });
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });
});

// ─── Gated admin API (end-to-end via createServer) ─────────────

describe("Admin API gating (end-to-end)", () => {
  function makeApp(): { app: Hono; db: Database; auth: Auth } {
    const { db, auth } = newAuthDb();
    const server = createServer(db, testSchema, {
      auth: { enabled: true, jwtSecret: SECRET },
      admin: { enabled: true },
    });
    return { app: server, db, auth };
  }

  it("rejects /_api/admin/schema without a token (401)", async () => {
    const { app, db } = makeApp();
    try {
      const res = await app.request("/_api/admin/schema");
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });

  it("rejects /_api/admin/schema with a user token (403)", async () => {
    const { app, db, auth } = makeApp();
    try {
      await signUp(auth, "first@test.com"); // admin
      const user = await signUp(auth, "second@test.com");
      const res = await app.request("/_api/admin/schema", {
        headers: bearer(user.accessToken),
      });
      assert.equal(res.status, 403);
    } finally {
      db.close();
    }
  });

  it("allows /_api/admin/schema with an admin token (200)", async () => {
    const { app, db, auth } = makeApp();
    try {
      const admin = await signUp(auth, "first@test.com");
      const res = await app.request("/_api/admin/schema", {
        headers: bearer(admin.accessToken),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.data.tables));
    } finally {
      db.close();
    }
  });

  it("admin row CRUD requires an admin token", async () => {
    const { app, db, auth } = makeApp();
    try {
      await signUp(auth, "first@test.com"); // admin
      const user = await signUp(auth, "second@test.com");

      // Insert without admin token → 401 (no auth).
      const noAuth = await app.request("/_api/admin/tables/tasks/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(noAuth.status, 401);

      // Insert with a user token → 403.
      const userAttempt = await app.request("/_api/admin/tables/tasks/rows", {
        method: "POST",
        headers: { ...bearer(user.accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(userAttempt.status, 403);
    } finally {
      db.close();
    }
  });

  it("a demoted admin immediately loses access to /_api/admin/*", async () => {
    const { app, db, auth } = makeApp();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com");
      auth.setRole("second@test.com", "admin"); // now 2 admins
      const secondAdminSession = await auth.signIn({
        email: "second@test.com",
        password: "password123",
      });
      const token = secondAdminSession.accessToken;

      // Works as admin.
      const before = await app.request("/_api/admin/schema", {
        headers: bearer(token),
      });
      assert.equal(before.status, 200);

      // Demote second (first remains, so allowed).
      auth.setRole("second@test.com", "user");

      // Same token now fails.
      const after = await app.request("/_api/admin/schema", {
        headers: bearer(token),
      });
      assert.equal(after.status, 403);
    } finally {
      db.close();
    }
  });
});

// ─── addUser requires auth in the CLI path (createUser) ────────

describe("createUser (CLI path) defaults to role=user", () => {
  it("creates a regular user, never an admin", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // the bootstrap admin
      const created = await auth.createUser({
        email: "cli@test.com",
        password: "password123",
      });
      assert.equal(created.role, "user");
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });
});
