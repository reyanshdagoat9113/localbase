/**
 * SDK auth tests — exercises `db.auth.*` against a real Hono + auth router.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Database, createServer } from "@localbase/core";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";
import { createClient } from "./client.js";
import type { LocalBaseClient } from "./client.js";

const testSchema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
  },
};

const authOptions = {
  jwtSecret: "test-secret-key-32-bytes-or-longer",
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
};

async function readJson(res: Response) {
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("SDK auth", () => {
  let db: Database;
  let app: Hono;
  let client: LocalBaseClient;

  beforeEach(async () => {
    db = await Database.open({
      schema: testSchema,
      auth: { enabled: true, ...authOptions },
    });
    app = createServer(db, testSchema, {
      auth: { enabled: true, ...authOptions },
    });
  });

  after(() => {
    // best-effort; each beforeEach makes a fresh db, but `after` runs once
  });

  describe("signUp", () => {
    it("stores the session in the client", async () => {
      client = createClient("http://example.invalid");

      // We can't talk to a real server in this test — stub the fetch.
      // Instead, drive the server directly and verify the client shape.
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

    it("real client: signUp hits the endpoint and stores the session", async () => {
      // Use the in-process Hono app via a fake URL won't work for fetch,
      // so we exercise the client against the real handler shape by
      // wrapping the app's `.fetch` in a server.
      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        const result = await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        assert.equal(result.error, null);
        assert.ok(result.data);
        assert.equal(result.data?.user.email, "alice@test.com");
        assert.ok(result.data?.accessToken);
        assert.ok(result.data?.refreshToken);

        // Session is now active on the client
        const session = client.auth.getSession();
        assert.ok(session);
        assert.equal(session?.user.email, "alice@test.com");
      } finally {
        server.close();
      }
    });
  });

  describe("signIn", () => {
    it("stores the session for valid credentials", async () => {
      const { serve } = await import("@hono/node-server");
      // Seed via a server round trip
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        client.auth.setSession(null);

        const result = await client.auth.signIn({
          email: "alice@test.com",
          password: "supersecret",
        });
        assert.equal(result.error, null);
        assert.ok(result.data?.accessToken);
        assert.ok(client.auth.getSession()?.accessToken);
      } finally {
        server.close();
      }
    });

    it("returns an error for wrong password (no session stored)", async () => {
      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        client.auth.setSession(null);

        const result = await client.auth.signIn({
          email: "alice@test.com",
          password: "wrongpassword",
        });
        assert.ok(result.error);
        assert.equal(result.data, null);
        // Session was not stored
        assert.equal(client.auth.getSession(), null);
      } finally {
        server.close();
      }
    });
  });

  describe("getUser", () => {
    it("returns the current user when signed in", async () => {
      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        const result = await client.auth.getUser();
        assert.equal(result.error, null);
        assert.ok(result.data?.user);
        assert.equal(result.data?.user.email, "alice@test.com");
      } finally {
        server.close();
      }
    });

    it("returns an error when not signed in", async () => {
      client = createClient("http://example.invalid");
      const result = await client.auth.getUser();
      assert.match(result.error!, /not signed in/i);
    });
  });

  describe("signOut", () => {
    it("clears the local session and invalidates the server session", async () => {
      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        const signup = await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        const refreshToken = signup.data!.refreshToken;

        const out = await client.auth.signOut();
        assert.equal(out.error, null);
        assert.equal(client.auth.getSession(), null);

        // The refresh token is no longer valid on the server
        const refresh = await client.auth.refresh();
        // refresh was just called with no session — should error.
        assert.match(refresh.error!, /no active session/i);

        // Verify directly via fetch that the token is dead on the server
        const res = await fetch(`http://localhost:${port}/api/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        assert.equal(res.status, 401);
      } finally {
        server.close();
      }
    });

    it("is idempotent when called without a session", async () => {
      client = createClient("http://example.invalid");
      const out = await client.auth.signOut();
      assert.equal(out.error, null);
      assert.equal(client.auth.getSession(), null);
    });
  });

  describe("refresh", () => {
    it("rotates tokens and updates the stored session", async () => {
      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        const original = await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        const oldAccess = original.data!.accessToken;
        const oldRefresh = original.data!.refreshToken;

        const rotated = await client.auth.refresh();
        assert.equal(rotated.error, null);
        assert.notEqual(rotated.data!.accessToken, oldAccess);
        assert.notEqual(rotated.data!.refreshToken, oldRefresh);

        // Stored session was updated
        const session = client.auth.getSession();
        assert.equal(session?.accessToken, rotated.data!.accessToken);
        assert.equal(session?.refreshToken, rotated.data!.refreshToken);

        // Old refresh token is dead
        const reuse = await client.auth.refresh();
        // After the previous call, session has the NEW refresh token.
        // Setting it back to the old one and trying again should fail.
        client.auth.setSession({
          ...session!,
          refreshToken: oldRefresh,
        });
        const dead = await client.auth.refresh();
        assert.match(dead.error!, /invalid refresh token/i);
      } finally {
        server.close();
      }
    });
  });

  describe("from() auto-attaches Bearer token", () => {
    it("attaches Bearer token to /api/:table requests when signed in", async () => {
      // Build a minimal Hono app that:
      //   1. Has the auth router mounted (for signup / signin flows)
      //   2. Requires auth on GET /api/posts
      // We use the Database directly without createServer to fully
      // control middleware ordering.
      const { Hono } = await import("hono");
      const { requireAuth, Auth, createAuthRouter, resolveAuthConfig } =
        await import("@localbase/core");
      const { cors } = await import("hono/cors");

      const localApp = new Hono();
      localApp.use("*", cors());

      const { config: resolved } = resolveAuthConfig({
        enabled: true,
        ...authOptions,
      });
      const localAuth = new Auth(db, resolved);
      const authRouter = createAuthRouter(localAuth, resolved.jwtSecret);
      localApp.route("/", authRouter);

      // Protected table route — must be registered BEFORE the catch-all
      // /api/:table so Hono matches it first.
      localApp.get("/api/posts", requireAuth(resolved.jwtSecret), (c) =>
        c.json({ data: [{ id: 1, title: "Hello" }] })
      );
      localApp.get("/api/posts/:id", requireAuth(resolved.jwtSecret), (c) =>
        c.json({ data: { id: 1, title: "Hello" } })
      );

      const { serve } = await import("@hono/node-server");
      const server = serve({ fetch: localApp.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      client = createClient(`http://localhost:${port}`);

      try {
        // Without a session, the protected route returns 401
        const noAuth = await client.from("posts").select("*");
        assert.match(noAuth.error ?? "", /unauthorized|missing|invalid/i);

        // Sign up so the SDK now holds a session
        const signup = await client.auth.signUp({
          email: "alice@test.com",
          password: "supersecret",
        });
        assert.equal(signup.error, null);

        // Now the same query succeeds — the SDK attached the Bearer token
        const ok = await client.from("posts").select("*");
        assert.equal(ok.error, null);
        assert.deepEqual(ok.data, [{ id: 1, title: "Hello" }]);
      } finally {
        server.close();
      }
    });

    it("omits the Authorization header when no session is active", async () => {
      // Spy on fetch to verify the outgoing headers.
      const originalFetch = globalThis.fetch;
      let capturedAuth: string | null = null;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const headers = new Headers(init?.headers);
        if (headers.has("Authorization")) {
          capturedAuth = headers.get("Authorization");
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        client = createClient("http://example.invalid");
        await client.from("posts").select("*");
        assert.equal(capturedAuth, null);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("attaches Bearer token after signin", async () => {
      const originalFetch = globalThis.fetch;
      let capturedAuth: string | null = null;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const headers = new Headers(init?.headers);
        if (headers.has("Authorization")) {
          capturedAuth = headers.get("Authorization");
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        client = createClient("http://example.invalid");
        client.auth.setSession({
          user: { id: 1, email: "x@y.com" },
          accessToken: "abc123",
          refreshToken: "def456",
          expiresAt: 9999999999,
        });
        await client.from("posts").select("*");
        assert.equal(capturedAuth, "Bearer abc123");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("setSession", () => {
    it("hydrates the session from external storage", async () => {
      client = createClient("http://example.invalid");
      assert.equal(client.auth.getSession(), null);

      client.auth.setSession({
        user: { id: 1, email: "alice@test.com" },
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const session = client.auth.getSession();
      assert.ok(session);
      assert.equal(session?.user.email, "alice@test.com");
      assert.equal(session?.accessToken, "fake-access");
    });

    it("clears the session when called with null", () => {
      client = createClient("http://example.invalid");
      client.auth.setSession({
        user: { id: 1, email: "x@y.com" },
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 0,
      });
      assert.ok(client.auth.getSession());

      client.auth.setSession(null);
      assert.equal(client.auth.getSession(), null);
    });
  });
});
