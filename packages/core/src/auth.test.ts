/**
 * Auth tests — unit tests for the Auth class, plus integration tests for
 * the auth router mounted on a real Hono server. Uses an in-memory SQLite
 * database so each `describe` block is hermetic.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import {
  Auth,
  AuthError,
  generateJwtSecret,
  hashPassword,
  parseExpiryToSeconds,
  resolveAuthConfig,
  requireAuth,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  generateRefreshToken,
} from "./auth/index.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";
import { createServer } from "./api.js";

const TEST_SECRET = "test-secret-key-32-bytes-or-longer";

const testSchema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
  },
};

const authOptions = {
  jwtSecret: TEST_SECRET,
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
};

function makeDb(auth = true) {
  return new Database({
    schema: testSchema,
    auth: auth ? { enabled: true, ...authOptions } : undefined,
  });
}

function makeAuth(db: Database) {
  return new Auth(db, {
    jwtSecret: TEST_SECRET,
    accessTokenExpiry: "1h",
    refreshTokenExpirySeconds: 86400,
    minPasswordLength: 8,
  });
}

async function readJson(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Capture the rejection from an async function. `assert.rejects` in modern
 * Node returns `undefined` on success, so we need a small helper to get
 * the error itself.
 */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected function to reject, but it resolved");
}

// ─── Auth class unit tests ─────────────────────────────────────

describe("Auth class", () => {
  let db: Database;
  let auth: Auth;

  beforeEach(() => {
    db = makeDb();
    auth = makeAuth(db);
  });

  after(() => db.close());

  it("signUp creates a user and returns a session", async () => {
    const session = await auth.signUp({
      email: "alice@test.com",
      password: "supersecret",
    });

    assert.equal(session.user.email, "alice@test.com");
    assert.ok(session.user.id > 0);
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);
    assert.ok(session.expiresAt > Math.floor(Date.now() / 1000));

    // Verify the user is in _users with a hashed password (not plaintext)
    const rows = db.select("_users", {
      filters: [{ column: "email", operator: "eq", value: "alice@test.com" }],
    }) as Array<{ email: string; password_hash: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "alice@test.com");
    assert.notEqual(rows[0].password_hash, "supersecret");
    assert.match(rows[0].password_hash, /^\$argon2/);

    // Verify the session row landed
    const sessions = db.select("_sessions") as Array<{
      user_id: number;
      token: string;
    }>;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].user_id, session.user.id);
    assert.equal(sessions[0].token, session.refreshToken);
  });

  it("signUp normalizes email to lowercase", async () => {
    const session = await auth.signUp({
      email: "  Alice@Test.COM  ",
      password: "supersecret",
    });
    assert.equal(session.user.email, "alice@test.com");
  });

  it("signUp rejects duplicate email with 409", async () => {
    await auth.signUp({ email: "dup@test.com", password: "supersecret" });
    await assert.rejects(
      auth.signUp({ email: "dup@test.com", password: "supersecret" }),
      (err: unknown) =>
        err instanceof AuthError && err.status === 409 &&
        /already registered/i.test(err.message)
    );
  });

  it("signUp rejects missing email", async () => {
    await assert.rejects(
      auth.signUp({ email: "", password: "supersecret" }),
      (err: unknown) =>
        err instanceof AuthError && err.status === 400
    );
  });

  it("signUp rejects invalid email format", async () => {
    await assert.rejects(
      auth.signUp({ email: "not-an-email", password: "supersecret" }),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 400 &&
        /invalid email/i.test(err.message)
    );
  });

  it("signUp rejects password shorter than minimum", async () => {
    await assert.rejects(
      auth.signUp({ email: "short@test.com", password: "short" }),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 400 &&
        /at least 8 characters/i.test(err.message)
    );
  });

  it("signUp rejects non-string password", async () => {
    await assert.rejects(
      auth.signUp({ email: "x@test.com", password: 123 as unknown }),
      (err: unknown) => err instanceof AuthError && err.status === 400
    );
  });

  it("signIn returns a session for valid credentials", async () => {
    await auth.signUp({ email: "alice@test.com", password: "supersecret" });
    const session = await auth.signIn({
      email: "alice@test.com",
      password: "supersecret",
    });
    assert.equal(session.user.email, "alice@test.com");
    assert.ok(session.accessToken);
  });

  it("signIn accepts the same email in any case", async () => {
    await auth.signUp({ email: "alice@test.com", password: "supersecret" });
    const session = await auth.signIn({
      email: "ALICE@TEST.COM",
      password: "supersecret",
    });
    assert.equal(session.user.email, "alice@test.com");
  });

  it("signIn rejects wrong password with same message as unknown email", async () => {
    await auth.signUp({ email: "alice@test.com", password: "supersecret" });

    const wrongPwd = await captureError(() =>
      auth.signIn({ email: "alice@test.com", password: "wrongpassword" })
    );
    const unknownEmail = await captureError(() =>
      auth.signIn({ email: "nobody@test.com", password: "supersecret" })
    );
    // Same error class, same status, same message — prevents email
    // enumeration attacks.
    assert.equal(
      (wrongPwd as AuthError).message,
      (unknownEmail as AuthError).message
    );
    assert.equal((wrongPwd as AuthError).status, 401);
  });

  it("signIn rejects missing password", async () => {
    await assert.rejects(
      auth.signIn({ email: "alice@test.com", password: "" }),
      (err: unknown) =>
        err instanceof AuthError && err.status === 400
    );
  });

  it("getUser returns the user by id", async () => {
    const session = await auth.signUp({
      email: "alice@test.com",
      password: "supersecret",
    });
    const fetched = auth.getUser(session.user.id);
    assert.ok(fetched);
    assert.equal(fetched.email, "alice@test.com");
  });

  it("getUser returns null for unknown id", () => {
    assert.equal(auth.getUser(9999), null);
  });

  it("signOut deletes the session by refresh token", async () => {
    const session = await auth.signUp({
      email: "alice@test.com",
      password: "supersecret",
    });
    await auth.signOut(session.refreshToken);

    const remaining = db.select("_sessions", {
      filters: [{ column: "token", operator: "eq", value: session.refreshToken }],
    });
    assert.equal(remaining.length, 0);
  });

  it("signOut is idempotent with no token", async () => {
    // Should not throw
    await auth.signOut(undefined);
    await auth.signOut(null);
    await auth.signOut("");
  });

  it("refresh rotates the token and invalidates the old one", async () => {
    const original = await auth.signUp({
      email: "alice@test.com",
      password: "supersecret",
    });
    const rotated = await auth.refresh(original.refreshToken);

    assert.notEqual(rotated.refreshToken, original.refreshToken);
    assert.notEqual(rotated.accessToken, original.accessToken);

    // Old refresh token is gone
    await assert.rejects(
      auth.refresh(original.refreshToken),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 401 &&
        /invalid refresh token/i.test(err.message)
    );

    // New refresh token still works
    const rotated2 = await auth.refresh(rotated.refreshToken);
    assert.ok(rotated2.accessToken);
  });

  it("refresh rejects an expired refresh token", async () => {
    // Manually insert an expired session
    const user = await auth.createUser({
      email: "alice@test.com",
      password: "supersecret",
    });
    db.insert("_sessions", {
      user_id: user.id,
      token: "expired-token",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    await assert.rejects(
      auth.refresh("expired-token"),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 401 &&
        /expired/i.test(err.message)
    );

    // The expired session should be cleaned up
    const rows = db.select("_sessions", {
      filters: [{ column: "token", operator: "eq", value: "expired-token" }],
    });
    assert.equal(rows.length, 0);
  });

  it("refresh rejects an empty refresh token", async () => {
    await assert.rejects(
      auth.refresh(""),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 401 &&
        /required/i.test(err.message)
    );
  });

  it("refresh cleans up orphan sessions whose user was deleted", async () => {
    // Force the orphan condition: temporarily disable FK constraints so we
    // can delete the user without also wiping the session row. In practice
    // a session without its user can only arise from raw SQL with FK off,
    // but the auth subsystem should still be defensive about it.
    const user = await auth.createUser({
      email: "alice@test.com",
      password: "supersecret",
    });
    db.insert("_sessions", {
      user_id: user.id,
      token: "orphan-token",
      expires_at: new Date(Date.now() + 100000).toISOString(),
    });
    db.raw().pragma("foreign_keys = OFF");
    try {
      db.raw().prepare("DELETE FROM _users WHERE id = ?").run(user.id);
    } finally {
      db.raw().pragma("foreign_keys = ON");
    }

    await captureError(() => auth.refresh("orphan-token"));
    // Verify the orphan session was cleaned up
    const remaining = db.select("_sessions", {
      filters: [{ column: "token", operator: "eq", value: "orphan-token" }],
    });
    assert.equal(remaining.length, 0);
  });

  it("createUser (admin) does not issue tokens", async () => {
    const user = await auth.createUser({
      email: "alice@test.com",
      password: "supersecret",
    });
    assert.equal(user.email, "alice@test.com");
    assert.ok(user.id);
    // No session was created
    const sessions = db.select("_sessions");
    assert.equal(sessions.length, 0);
  });

  it("listUsers returns all users without password hashes", async () => {
    await auth.createUser({ email: "alice@test.com", password: "supersecret1" });
    await auth.createUser({ email: "bob@test.com", password: "supersecret2" });

    const users = auth.listUsers();
    assert.equal(users.length, 2);
    // Order is by created_at asc
    assert.equal(users[0].email, "alice@test.com");
    assert.equal(users[1].email, "bob@test.com");
    // No `password_hash` field leaks into the public user
    for (const u of users) {
      assert.equal(
        (u as unknown as Record<string, unknown>).password_hash,
        undefined
      );
    }
  });

  it("setPassword updates the password hash", async () => {
    await auth.createUser({ email: "alice@test.com", password: "oldpassword" });

    await auth.setPassword("alice@test.com", "newpassword");

    // Old password no longer works
    await assert.rejects(
      auth.signIn({ email: "alice@test.com", password: "oldpassword" })
    );
    // New password works
    const session = await auth.signIn({
      email: "alice@test.com",
      password: "newpassword",
    });
    assert.ok(session.accessToken);
  });

  it("setPassword rejects unknown user with 404", async () => {
    await assert.rejects(
      auth.setPassword("nobody@test.com", "newpassword1"),
      (err: unknown) =>
        err instanceof AuthError &&
        err.status === 404 &&
        /no user/i.test(err.message)
    );
  });
});

// ─── Database integration ──────────────────────────────────────

describe("Database + auth", () => {
  it("provisions _users and _sessions tables when auth.enabled", () => {
    const db = makeDb();
    const applied = db.getAppliedMigrations();
    assert.ok(applied.has("_users"));
    assert.ok(applied.has("_sessions"));
    db.close();
  });

  it("does NOT provision auth tables when auth is disabled", () => {
    const db = makeDb(false);
    const applied = db.getAppliedMigrations();
    assert.ok(applied.has("posts"));
    assert.ok(!applied.has("_users"));
    assert.ok(!applied.has("_sessions"));
    db.close();
  });

  it("preserves _users across db.reset()", () => {
    const db = makeDb();
    // Insert a user
    db.insert("_users", {
      email: "alice@test.com",
      password_hash: "fake-hash",
    });
    const userId = (db.selectById("_users", 1) as { id: number }).id;

    // Reset — user tables go, system tables stay
    db.reset();

    const survived = db.selectById("_users", userId) as
      | { id: number; email: string }
      | undefined;
    assert.ok(survived, "_users row should survive reset");
    assert.equal(survived.email, "alice@test.com");
    db.close();
  });

  it("getAuthConfig() returns the auth config when enabled", () => {
    const db = makeDb();
    const cfg = db.getAuthConfig();
    assert.ok(cfg?.enabled);
    db.close();
  });

  it("getAuthConfig() returns undefined when auth is disabled", () => {
    const db = makeDb(false);
    assert.equal(db.getAuthConfig(), undefined);
    db.close();
  });
});

// ─── Hash helpers ──────────────────────────────────────────────

describe("password hashing", () => {
  it("hashPassword produces an Argon2id PHC-format string", async () => {
    const h = await hashPassword("supersecret");
    assert.match(h, /^\$argon2id\$/);
  });

  it("verifyPassword returns true for the right password", async () => {
    const h = await hashPassword("supersecret");
    assert.equal(await verifyPassword(h, "supersecret"), true);
  });

  it("verifyPassword returns false for the wrong password", async () => {
    const h = await hashPassword("supersecret");
    assert.equal(await verifyPassword(h, "wrongpassword"), false);
  });

  it("verifyPassword returns false on malformed hash", async () => {
    assert.equal(await verifyPassword("not-a-real-hash", "anything"), false);
  });

  it("two hashes of the same password differ (random salt)", async () => {
    const a = await hashPassword("supersecret");
    const b = await hashPassword("supersecret");
    assert.notEqual(a, b);
  });
});

// ─── Token helpers ─────────────────────────────────────────────

describe("access tokens (jose)", () => {
  it("signs and verifies a token round trip", async () => {
    const token = await signAccessToken(
      { id: 42, email: "alice@test.com" },
      TEST_SECRET,
      "1h"
    );
    const claims = await verifyAccessToken(token, TEST_SECRET);
    assert.equal(claims.sub, "42");
    assert.equal(claims.email, "alice@test.com");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signAccessToken(
      { id: 1, email: "x@y.com" },
      "secret-a",
      "1h"
    );
    await assert.rejects(verifyAccessToken(token, "secret-b"));
  });

  it("rejects an expired token", async () => {
    const token = await signAccessToken(
      { id: 1, email: "x@y.com" },
      TEST_SECRET,
      "0s" // 0 seconds — already expired by the time we verify
    );
    await assert.rejects(
      verifyAccessToken(token, TEST_SECRET),
      (err: unknown) => err instanceof Error && err.name === "JWTExpired"
    );
  });
});

describe("refresh tokens", () => {
  it("generates a 64-character hex string", () => {
    const t = generateRefreshToken();
    assert.equal(t.length, 64);
    assert.match(t, /^[0-9a-f]{64}$/);
  });

  it("generates a unique token each time", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(a, b);
  });
});

describe("config helpers", () => {
  it("parseExpiryToSeconds handles all shorthand units", () => {
    assert.equal(parseExpiryToSeconds("30s"), 30);
    assert.equal(parseExpiryToSeconds("5m"), 300);
    assert.equal(parseExpiryToSeconds("2h"), 7200);
    assert.equal(parseExpiryToSeconds("7d"), 604800);
  });

  it("parseExpiryToSeconds throws on malformed input", () => {
    assert.throws(() => parseExpiryToSeconds("forever"));
    assert.throws(() => parseExpiryToSeconds("1y"));
    assert.throws(() => parseExpiryToSeconds(""));
  });

  it("resolveAuthConfig fills defaults", () => {
    const { config, secretWasGenerated } = resolveAuthConfig({
      enabled: true,
    });
    assert.equal(secretWasGenerated, true);
    assert.equal(config.accessTokenExpiry, "1h");
    assert.equal(config.refreshTokenExpirySeconds, 30 * 24 * 60 * 60);
    assert.equal(config.minPasswordLength, 8);
    assert.equal(config.jwtSecret.length, 64); // generated hex
  });

  it("resolveAuthConfig uses provided secret without flagging generation", () => {
    const { config, secretWasGenerated } = resolveAuthConfig({
      enabled: true,
      jwtSecret: "explicit",
    });
    assert.equal(config.jwtSecret, "explicit");
    assert.equal(secretWasGenerated, false);
  });

  it("resolveAuthConfig rejects malformed accessTokenExpiry", () => {
    assert.throws(() =>
      resolveAuthConfig({ enabled: true, accessTokenExpiry: "forever" })
    );
  });

  it("generateJwtSecret produces a 64-char hex string", () => {
    const s = generateJwtSecret();
    assert.equal(s.length, 64);
    assert.match(s, /^[0-9a-f]+$/);
  });
});

// ─── requireAuth middleware ────────────────────────────────────

describe("requireAuth middleware", () => {
  let app: Hono;
  let auth: Auth;
  let db: Database;
  let validToken: string;
  let userId: number;

  before(async () => {
    db = makeDb();
    auth = makeAuth(db);
    const session = await auth.signUp({
      email: "alice@test.com",
      password: "supersecret",
    });
    validToken = session.accessToken;
    userId = session.user.id;

    app = createServer(db, testSchema, {
      auth: { enabled: true, ...authOptions },
    });
    // Mount a protected route manually for the test
    app.get("/protected", requireAuth(TEST_SECRET), (c) => {
      const u = c.get("user");
      return c.json({ data: u });
    });
  });

  after(() => db.close());

  it("401s when Authorization header is missing", async () => {
    const res = await app.request("/protected");
    const { status, body } = await readJson(res);
    assert.equal(status, 401);
    assert.match(body.error as string, /missing/i);
  });

  it("401s when scheme is not Bearer", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    assert.equal(res.status, 401);
  });

  it("401s on a token signed with the wrong secret", async () => {
    const bad = await signAccessToken(
      { id: userId, email: "alice@test.com" },
      "wrong-secret",
      "1h"
    );
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${bad}` },
    });
    assert.equal(res.status, 401);
  });

  it("401s on a malformed token", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    assert.equal(res.status, 401);
  });

  it("200s on a valid token and exposes c.get('user')", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    const data = body.data as { id: number; email: string };
    assert.equal(data.id, userId);
    assert.equal(data.email, "alice@test.com");
  });
});

// ─── Auth router integration ───────────────────────────────────

describe("auth router (HTTP)", () => {
  let app: Hono;
  let db: Database;

  before(() => {
    db = makeDb();
    app = createServer(db, testSchema, {
      auth: { enabled: true, ...authOptions },
    });
  });

  after(() => db.close());

  describe("POST /api/auth/signup", () => {
    it("201s and returns a session on success", async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "alice@test.com",
          password: "supersecret",
        }),
      });
      const { status, body } = await readJson(res);
      assert.equal(status, 201);
      const data = body.data as {
        user: { id: number; email: string };
        accessToken: string;
        refreshToken: string;
      };
      assert.equal(data.user.email, "alice@test.com");
      assert.ok(data.accessToken);
      assert.ok(data.refreshToken);
    });

    it("400s on missing email", async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "supersecret" }),
      });
      assert.equal(res.status, 400);
    });

    it("400s on missing password", async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@y.com" }),
      });
      assert.equal(res.status, 400);
    });

    it("400s on non-JSON body", async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all",
      });
      assert.equal(res.status, 400);
    });

    it("409s on duplicate email", async () => {
      await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dup@test.com",
          password: "supersecret",
        }),
      });
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "dup@test.com",
          password: "supersecret",
        }),
      });
      assert.equal(res.status, 409);
    });
  });

  describe("POST /api/auth/signin", () => {
    before(async () => {
      await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "signin@test.com",
          password: "supersecret",
        }),
      });
    });

    it("200s with a session on correct credentials", async () => {
      const res = await app.request("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "signin@test.com",
          password: "supersecret",
        }),
      });
      const { status, body } = await readJson(res);
      assert.equal(status, 200);
      const data = body.data as { accessToken: string };
      assert.ok(data.accessToken);
    });

    it("401s on wrong password", async () => {
      const res = await app.request("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "signin@test.com",
          password: "wrongpassword",
        }),
      });
      assert.equal(res.status, 401);
    });

    it("401s on unknown email (same message as wrong password)", async () => {
      const res = await app.request("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nobody@test.com",
          password: "supersecret",
        }),
      });
      assert.equal(res.status, 401);
    });
  });

  describe("GET /api/auth/user", () => {
    let accessToken: string;

    before(async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "me@test.com",
          password: "supersecret",
        }),
      });
      const body = (await res.json()) as { data: { accessToken: string } };
      accessToken = body.data.accessToken;
    });

    it("200s with the current user when given a valid token", async () => {
      const res = await app.request("/api/auth/user", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const { status, body } = await readJson(res);
      assert.equal(status, 200);
      const data = body.data as { user: { email: string } };
      assert.equal(data.user.email, "me@test.com");
    });

    it("401s without a token", async () => {
      const res = await app.request("/api/auth/user");
      assert.equal(res.status, 401);
    });

    it("401s with an invalid token", async () => {
      const res = await app.request("/api/auth/user", {
        headers: { Authorization: "Bearer garbage" },
      });
      assert.equal(res.status, 401);
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("200s with a rotated session when given a valid refresh token", async () => {
      const signup = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "refresh@test.com",
          password: "supersecret",
        }),
      });
      const { data: original } = (await signup.json()) as {
        data: { accessToken: string; refreshToken: string };
      };

      const res = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: original.refreshToken }),
      });
      const { status, body } = await readJson(res);
      assert.equal(status, 200);
      const data = body.data as {
        accessToken: string;
        refreshToken: string;
      };
      assert.notEqual(data.accessToken, original.accessToken);
      assert.notEqual(data.refreshToken, original.refreshToken);
    });

    it("401s on an invalid refresh token", async () => {
      const res = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: "garbage" }),
      });
      assert.equal(res.status, 401);
    });

    it("401s when the refresh token has already been rotated", async () => {
      const signup = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "rotate@test.com",
          password: "supersecret",
        }),
      });
      const { data: original } = (await signup.json()) as {
        data: { refreshToken: string };
      };

      // Rotate once — succeeds
      await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: original.refreshToken }),
      });

      // Reuse the old token — fails
      const reuse = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: original.refreshToken }),
      });
      assert.equal(reuse.status, 401);
    });
  });

  describe("POST /api/auth/signout", () => {
    it("200s and deletes the session", async () => {
      const signup = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "signout@test.com",
          password: "supersecret",
        }),
      });
      const { data } = (await signup.json()) as {
        data: { accessToken: string; refreshToken: string };
      };

      const res = await app.request("/api/auth/signout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.accessToken}`,
        },
        body: JSON.stringify({ refreshToken: data.refreshToken }),
      });
      assert.equal(res.status, 200);

      // The refresh token is now dead
      const refresh = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: data.refreshToken }),
      });
      assert.equal(refresh.status, 401);
    });

    it("401s without a valid access token", async () => {
      const res = await app.request("/api/auth/signout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 401);
    });
  });
});

// ─── Auth disabled — auth routes should 404 ────────────────────

describe("auth disabled", () => {
  it("does not mount auth routes when auth.enabled is false", async () => {
    const db = new Database({ schema: testSchema });
    const app = createServer(db, testSchema, {
      auth: { enabled: false },
    });
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.com", password: "supersecret" }),
    });
    assert.equal(res.status, 404);
    db.close();
  });

  it("does not mount auth routes when no auth config is given", async () => {
    const db = new Database({ schema: testSchema });
    const app = createServer(db, testSchema);
    const res = await app.request("/api/auth/user");
    assert.equal(res.status, 404);
    db.close();
  });

  it("accepts the legacy authConfig-as-third-arg shape", async () => {
    const db = new Database({ schema: testSchema });
    // Passing AuthConfig directly (no `{ auth: ... }` wrapper) should work.
    const app = createServer(db, testSchema, {
      enabled: true,
      ...authOptions,
    });
    const res = await app.request("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@y.com", password: "supersecret" }),
    });
    assert.equal(res.status, 201);
    db.close();
  });
});
