import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { createServer } from "./api.js";
import { Auth } from "./auth/auth.js";
import { resolveAuthConfig } from "./auth/config.js";
import { signAccessToken } from "./auth/tokens.js";
import { SignJWT, jwtVerify } from "jose";
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
  it("the very first signup becomes the owner", async () => {
    const { db, auth } = newAuthDb();
    try {
      const session = await signUp(auth, "first@test.com");
      assert.equal(session.user.role, "owner");

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

  it("the owner claim is actually embedded in the JWT", async () => {
    const { db, auth } = newAuthDb();
    try {
      const session = await signUp(auth, "first@test.com");
      // Decode + verify the real session token and assert the role claim is
      // present (not just that a token string exists).
      const { payload } = await jwtVerify(
        session.accessToken,
        new TextEncoder().encode(SECRET)
      );
      assert.equal(payload.role, "owner");
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

  it("refuses to change the owner role", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // admin
      assert.throws(
        () => auth.setRole("first@test.com", "admin"),
        /owner role cannot be changed/i
      );
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });

  it("demotes an admin while the owner remains", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com");
      auth.setRole("second@test.com", "admin");
      const demoted = auth.setRole("second@test.com", "user");
      assert.equal(demoted.role, "user");
      assert.equal(auth.countAdmins(), 1);
    } finally {
      db.close();
    }
  });

  it("REFUSES to demote the owner", async () => {
    const { db, auth } = newAuthDb();
    try {
      await signUp(auth, "only@test.com"); // the sole admin
      assert.throws(
        () => auth.setRole("only@test.com", "user"),
        (err: unknown) =>
          err instanceof Error &&
          (err as { status?: number }).status === 409 &&
          /owner role cannot be changed/i.test(err.message)
      );
      // Still has administrative access.
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
    const app = createServer(db, testSchema, { auth: { enabled: false } });
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
      // The 401 is generic by design — it must not reveal that the account
      // was deleted (no existence oracle for valid-signature-but-gone-user).
      const body = await res.json();
      assert.doesNotMatch(body.error, /delete|not found|no longer|removed/i);
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
      const forgedApp = createServer(db, testSchema, {
        auth: { enabled: false },
      });
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

  // ── M2.5: the admin gate must not trust the JWT role claim ──

  it("returns 403 for a FORGED role claim (valid signature, role:user in DB)", async () => {
    // The headline property: requireAdmin re-reads the live role from _users.
    // A token that claims role:"admin" but whose user is role:"user" — even
    // though signed with the correct secret — must be rejected with 403, not
    // honored (and not a 401: the signature verifies).
    const { app, db, auth } = gatedApp();
    try {
      await signUp(auth, "admin@test.com"); // bootstrap admin
      const victim = db.insert("_users", {
        email: "victim@test.com",
        password_hash: "x",
        role: "user",
      })[0] as { id: number };
      const forged = await signAccessToken(
        { id: victim.id, email: "victim@test.com", role: "admin" },
        SECRET,
        "1h"
      );
      const res = await app.request("/_test/admin-only", {
        headers: bearer(forged),
      });
      assert.equal(res.status, 403);
    } finally {
      db.close();
    }
  });

  it("returns 401 for an EXPIRED access token", async () => {
    // signAccessToken cannot mint a past expiry, so forge one directly with
    // jose. Pins the JWTExpired branch in requireAdmin.
    const { app, db, auth } = gatedApp();
    try {
      const s = await signUp(auth, "admin@test.com");
      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({ email: s.user.email, role: "admin" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(String(s.user.id))
        .setIssuedAt(now - 3600)
        .setExpirationTime(now - 60)
        .sign(new TextEncoder().encode(SECRET));
      const res = await app.request("/_test/admin-only", {
        headers: bearer(expired),
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.match(body.error, /expired/i);
    } finally {
      db.close();
    }
  });

  it("returns 401 for a TAMPERED token (signature changed)", async () => {
    const { app, db, auth } = gatedApp();
    try {
      const s = await signUp(auth, "admin@test.com");
      // Flip a MIDDLE character of the signature segment. The trailing
      // base64url char is frequently padding-tolerant, so flipping only the
      // last char is non-deterministic; corrupting the middle reliably
      // breaks signature verification regardless of the exact bytes.
      const [header, payloadSeg, sig] = s.accessToken.split(".");
      const mid = Math.floor(sig.length / 2);
      const flip = sig[mid] === "A" ? "B" : "A";
      const tampered = `${header}.${payloadSeg}.${sig.slice(
        0,
        mid
      )}${flip}${sig.slice(mid + 1)}`;
      const res = await app.request("/_test/admin-only", {
        headers: bearer(tampered),
      });
      assert.equal(res.status, 401);
    } finally {
      db.close();
    }
  });

  it("returns 403 for a user whose role is an unexpected value (superuser)", async () => {
    // Guards against a future refactor that swaps strict-equality for
    // "anything but 'user' is admin". Only explicit administrative roles pass.
    const { app, db, auth } = gatedApp();
    try {
      await signUp(auth, "admin@test.com");
      const weird = db.insert("_users", {
        email: "super@test.com",
        password_hash: "x",
        role: "superuser",
      })[0] as { id: number };
      const token = await signAccessToken(
        { id: weird.id, email: "super@test.com", role: "superuser" },
        SECRET,
        "1h"
      );
      const res = await app.request("/_test/admin-only", {
        headers: bearer(token),
      });
      assert.equal(res.status, 403);
    } finally {
      db.close();
    }
  });

  it("rejects assorted malformed Authorization header forms; lowercase 'bearer' still works", async () => {
    const { app, db, auth } = gatedApp();
    try {
      const s = await signUp(auth, "admin@test.com");

      const emptyToken = await app.request("/_test/admin-only", {
        headers: { Authorization: "Bearer " },
      });
      assert.equal(emptyToken.status, 401);

      const wrongScheme = await app.request("/_test/admin-only", {
        headers: { Authorization: "Basic xxx" },
      });
      assert.equal(wrongScheme.status, 401);

      // The scheme check is case-insensitive: a lowercase 'bearer' with a
      // valid token must authenticate.
      const lower = await app.request("/_test/admin-only", {
        headers: { Authorization: "bearer " + s.accessToken },
      });
      assert.equal(lower.status, 200);
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

  it("a demoted admin is blocked on WRITE verbs too (POST/PATCH/DELETE)", async () => {
    // The live-role re-read is the headline authz property. The GET test
    // above pins it for reads; this pins it for MUTATIONS — the dangerous
    // half. A stale role:'admin' token must not reach any write handler.
    const { app, db, auth } = makeApp();
    try {
      await signUp(auth, "first@test.com"); // admin
      await signUp(auth, "second@test.com");
      auth.setRole("second@test.com", "admin"); // now 2 admins
      const second = await auth.signIn({
        email: "second@test.com",
        password: "password123",
      });
      const token = second.accessToken;

      // Seed a row as the (still-admin) second user — a PATCH/DELETE target.
      const insert = await app.request("/_api/admin/tables/tasks/rows", {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "seed" }),
      });
      assert.equal(insert.status, 201);
      const id = (await insert.json()).data.id;

      // Demote second (first remains admin, so this is allowed).
      auth.setRole("second@test.com", "user");

      const post = await app.request("/_api/admin/tables/tasks/rows", {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "after-demote" }),
      });
      assert.equal(post.status, 403);
      const patch = await app.request(`/_api/admin/tables/tasks/rows/${id}`, {
        method: "PATCH",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "mutated" }),
      });
      assert.equal(patch.status, 403);
      const del = await app.request(`/_api/admin/tables/tasks/rows/${id}`, {
        method: "DELETE",
        headers: bearer(token),
      });
      assert.equal(del.status, 403);

      // Only the seeded row remains — no second insert, no mutation, no delete.
      const tasks = db.select("tasks") as Array<{ title: string }>;
      assert.deepEqual(tasks.map((t) => t.title), ["seed"]);
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

// ─── No-auth mode: admin API is ungated ─────────────────────────

describe("No-auth mode (admin API ungated — the posture the CLI gate protects)", () => {
  it("GET schema and POST rows succeed with NO Authorization header", async () => {
    // When auth is disabled, createServer mounts the admin API ungated. This
    // is the exact contract the CLI's unsafeAdminBinding gate exists to keep
    // on localhost — pinning it here catches a future default-deny change
    // that would silently break the no-auth dev workflow.
    const db = new Database({ schema: testSchema });
    try {
      const app = createServer(db, testSchema, {
        admin: { enabled: true },
        // Pin the explicit no-auth posture these tests exercise.
        auth: { enabled: false },
      });

      const get = await app.request("/_api/admin/schema");
      assert.equal(get.status, 200);
      const getBody = await get.json();
      assert.ok(Array.isArray(getBody.data.tables));

      const post = await app.request("/_api/admin/tables/tasks/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "ungated-insert" }),
      });
      assert.equal(post.status, 201);
      const postBody = await post.json();
      assert.equal(postBody.data.title, "ungated-insert");
    } finally {
      db.close();
    }
  });

  it("GET /_api/admin/meta reports authEnabled: false", async () => {
    // The Studio boots against this endpoint: auth-off servers must never
    // show a login screen, so meta must be reachable and honest.
    const db = new Database({ schema: testSchema });
    try {
      const app = createServer(db, testSchema, {
        admin: { enabled: true },
        auth: { enabled: false },
      });
      const res = await app.request("/_api/admin/meta");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.authEnabled, false);
    } finally {
      db.close();
    }
  });

  it("GET /_api/admin/meta is ungated even when auth is on", async () => {
    const { db } = newAuthDb();
    try {
      const app = createServer(db, testSchema, {
        auth: { enabled: true, jwtSecret: SECRET },
        admin: { enabled: true },
      });
      const res = await app.request("/_api/admin/meta");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.authEnabled, true);
    } finally {
      db.close();
    }
  });
});
