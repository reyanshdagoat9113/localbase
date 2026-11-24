/**
 * SDK integration tests for the realtime security contract (Workstream 1.2).
 *
 * The core suite proves the wire protocol; these tests prove the SDK client
 * drives it correctly: it authenticates via the initial auth message (never the
 * URL), enforces owner-scoped delivery through the public `subscribe` API,
 * reconnects with a refreshed token after expiry, and surfaces auth/resync
 * events to the application.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import {
  Database,
  createServer,
  createRealtimeServer,
  signAccessToken,
} from "@localbase/core";
import type { DatabaseSchema, PoliciesConfig, RealtimeServer } from "@localbase/core";
import { createClient } from "./client.js";
import type { LocalBaseClient, StoredSession } from "./index.js";

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
};
const POLICY: PoliciesConfig = { posts: { ownerColumn: "owner_id" } };

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function makeSession(
  token: string,
  id: number,
  email: string
): Promise<StoredSession> {
  return {
    user: { id, email },
    accessToken: token,
    refreshToken: "refresh-not-used-here",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function setup(): Promise<{
  db: Database;
  app: ReturnType<typeof createServer>;
  server: ReturnType<typeof serve>;
  rtRef: { current: RealtimeServer };
  port: number;
  aliceToken: string;
  bobToken: string;
  close: () => Promise<void>;
}> {
  const db = await Database.open({ schema, auth: authConfig });
  const insertUser = db
    .sqliteRaw()
    .prepare(`INSERT INTO "_users" ("id","email","password_hash","role") VALUES (?,?,?,?)`);
  insertUser.run(1, "alice@x.com", "x", "user");
  insertUser.run(2, "bob@x.com", "x", "user");

  const app = createServer(db, schema, { auth: authConfig, policies: POLICY });
  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;

  const policyMap = (await import("@localbase/core")).resolvePolicies(POLICY, schema);
  const rtRef: { current: RealtimeServer } = {
    current: createRealtimeServer({
      server: server as HttpServer,
      database: db,
      authSecret: SECRET,
      policies: policyMap,
    }),
  };

  const aliceToken = await signAccessToken({ id: 1, email: "alice@x.com", role: "user" }, SECRET, "1h");
  const bobToken = await signAccessToken({ id: 2, email: "bob@x.com", role: "user" }, SECRET, "1h");

  return {
    db,
    app,
    server,
    rtRef,
    port,
    aliceToken,
    bobToken,
    async close() {
      await rtRef.current.close();
      if (
        "closeAllConnections" in server &&
        typeof server.closeAllConnections === "function"
      ) {
        server.closeAllConnections();
      }
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
      await db.close();
    },
  };
}

describe("SDK realtime security", () => {
  it("delivers owner-scoped events through the authenticated SDK", async () => {
    const h = await setup();
    try {
      const alice = createClient(`http://localhost:${h.port}`);
      alice.auth.setSession(await makeSession(h.aliceToken, 1, "alice@x.com"));
      const bob = createClient(`http://localhost:${h.port}`);
      bob.auth.setSession(await makeSession(h.bobToken, 2, "bob@x.com"));

      const aliceEvents: unknown[] = [];
      const bobEvents: unknown[] = [];
      alice.subscribe<{ title: string }>("posts", (e) => aliceEvents.push(e.row.title));
      bob.subscribe<{ title: string }>("posts", (e) => bobEvents.push(e.row.title));

      // Give the SDK time to open + authenticate + subscribe.
      await wait(250);

      await h.app.request(
        "/api/posts",
        { method: "POST", headers: { "Content-Type": "application/json", ...bearer(h.aliceToken) }, body: JSON.stringify({ title: "alice" }) }
      );
      await h.app.request(
        "/api/posts",
        { method: "POST", headers: { "Content-Type": "application/json", ...bearer(h.bobToken) }, body: JSON.stringify({ title: "bob" }) }
      );
      await wait(250);

      assert.deepEqual(aliceEvents, ["alice"], "alice sees only her own row");
      assert.deepEqual(bobEvents, ["bob"], "bob sees only his own row");
      alice.close();
      bob.close();
    } finally {
      await h.close();
    }
  });

  it("surfaces onAuthError and stops retrying when the token is invalid", async () => {
    const h = await setup();
    try {
      let authError: string | null = null;
      const db = createClient(`http://localhost:${h.port}`, {
        onAuthError: (msg) => {
          authError = msg;
        },
      });
      // Plant a bogus access token; the server will reject the handshake.
      db.auth.setSession(await makeSession("not-a-valid-token", 1, "alice@x.com"));

      let received = 0;
      db.subscribe("posts", () => received++);

      // The SDK should connect, send the bad token, receive auth:error, surface
      // it once, and NOT retry. Wait long enough that a retry would have fired.
      await wait(1500);

      assert.ok(authError !== null, "onAuthError must be surfaced");
      assert.equal(received, 0, "no events should be delivered with a bad token");
      await db.close();
    } finally {
      await h.close();
    }
  });

  it("retries active subscriptions when a valid session replaces a rejected one", async () => {
    const h = await setup();
    try {
      let authErrors = 0;
      const alice = createClient(`http://localhost:${h.port}`, {
        onAuthError: () => {
          authErrors++;
        },
      });
      alice.auth.setSession(await makeSession("not-a-valid-token", 1, "alice@x.com"));

      const events: string[] = [];
      alice.subscribe<{ title: string }>("posts", (e) => events.push(e.row.title));
      await wait(300);
      assert.equal(authErrors, 1, "the initial bad token should fail once");

      alice.auth.setSession(await makeSession(h.aliceToken, 1, "alice@x.com"));
      await wait(250);

      await h.app.request(
        "/api/posts",
        { method: "POST", headers: { "Content-Type": "application/json", ...bearer(h.aliceToken) }, body: JSON.stringify({ title: "after-valid-session" }) }
      );
      await wait(300);

      assert.deepEqual(events, ["after-valid-session"]);
      alice.close();
    } finally {
      await h.close();
    }
  });

  it("reconnects with the refreshed token after expiry and keeps delivering", async () => {
    // Short-lived token so the server closes (4003) within ~1s.
    const shortToken = await signAccessToken({ id: 1, email: "alice@x.com", role: "user" }, SECRET, "1s");
    const longToken = await signAccessToken({ id: 1, email: "alice@x.com", role: "user" }, SECRET, "1h");
    const h = await setup();
    try {
      const alice = createClient(`http://localhost:${h.port}`);
      // Start with the short-lived token.
      alice.auth.setSession(await makeSession(shortToken, 1, "alice@x.com"));

      const events: string[] = [];
      alice.subscribe<{ title: string }>("posts", (e) => events.push(e.row.title));
      await wait(200);

      // Rotate to a fresh, long-lived token BEFORE the old one expires, the way
      // a successful `auth.refresh()` would. The next reconnect must use it.
      alice.auth.setSession(await makeSession(longToken, 1, "alice@x.com"));

      // Wait out the 1s token lifetime + the SDK's 1s reconnect backoff.
      await wait(2800);

      // A row inserted now must still reach alice — proving she re-authenticated
      // with the refreshed token after the 4003 close.
      await h.app.request(
        "/api/posts",
        { method: "POST", headers: { "Content-Type": "application/json", ...bearer(longToken) }, body: JSON.stringify({ title: "after-reconnect" }) }
      );
      await wait(300);

      assert.ok(
        events.includes("after-reconnect"),
        `reconnect with refreshed token must resume delivery; got ${JSON.stringify(events)}`
      );
      alice.close();
    } finally {
      await h.close();
    }
  });

  it("surfaces onResync when the server restarts (new epoch)", async () => {
    const h = await setup();
    try {
      let resyncReason: string | null = null;
      const alice = createClient(`http://localhost:${h.port}`, {
        onResync: (reason) => {
          resyncReason = reason;
        },
      });
      alice.auth.setSession(await makeSession(h.aliceToken, 1, "alice@x.com"));

      const events: string[] = [];
      alice.subscribe<{ title: string }>("posts", (e) => events.push(e.row.title));
      await wait(200);

      // Seed an event so the SDK stores an epoch-aware cursor.
      await h.app.request(
        "/api/posts",
        { method: "POST", headers: { "Content-Type": "application/json", ...bearer(h.aliceToken) }, body: JSON.stringify({ title: "seed" }) }
      );
      await wait(200);

      // Simulate a server restart: tear down the realtime server and stand up a
      // fresh one (new epoch) on the same HTTP server. The SDK's socket is
      // terminated; it reconnects and re-subscribes with the now-stale cursor,
      // eliciting a resync-required from the new epoch.
      await h.rtRef.current.close();
      const policyMap = (await import("@localbase/core")).resolvePolicies(POLICY, schema);
      h.rtRef.current = createRealtimeServer({
        server: h.server as HttpServer,
        database: h.db,
        authSecret: SECRET,
        policies: policyMap,
      });

      // SDK reconnect backoff is ~1s.
      await wait(2000);

      assert.ok(resyncReason !== null, "onResync must be surfaced after a restart");
      alice.close();
    } finally {
      await h.close();
    }
  });
});
