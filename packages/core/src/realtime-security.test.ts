/**
 * Realtime security regression suite (Workstream 1.2, gate RT-P0).
 *
 * These tests prove the realtime WebSocket honors the same auth + RLS contract
 * as the public REST API, even on the live event stream and on replay. The
 * auth-disabled behavior (local development) continues to be covered by
 * `realtime.test.ts`; this file exercises the authenticated, policy-protected
 * surface exclusively.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { Database, createServer, createRealtimeServer, signAccessToken } from "./index.js";
import { resolvePolicies } from "./rls.js";
import type {
  DatabaseSchema,
  PoliciesConfig,
  RealtimeConfig,
  RealtimeServer,
} from "./index.js";

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
  tags: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};

const POLICY: PoliciesConfig = { posts: { ownerColumn: "owner_id" } };

interface Row {
  id: number;
  title: string;
  owner_id: number;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
function jsonReq(method: string, body: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SetupOpts {
  policies?: PoliciesConfig;
  realtime?: RealtimeConfig;
  roleTtlMs?: number;
}

interface Harness {
  db: Database;
  app: Hono;
  server: ReturnType<typeof serve>;
  rt: RealtimeServer;
  port: number;
  alice: string; // admin token (user id 1)
  bob: string; // user token (user id 2)
  carol: string; // user token (user id 3)
  close: () => Promise<void>;
}

async function setup(opts: SetupOpts = {}): Promise<Harness> {
  const db = await Database.open({ schema, auth: authConfig });
  const insertUser = db.sqliteRaw().prepare(
    `INSERT INTO "_users" ("id","email","password_hash","role") VALUES (?,?,?,?)`
  );
  insertUser.run(1, "alice@x.com", "x", "admin");
  insertUser.run(2, "bob@x.com", "x", "user");
  insertUser.run(3, "carol@x.com", "x", "user");

  const policies = opts.policies ?? POLICY;
  const app = createServer(db, schema, { auth: authConfig, policies });
  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;
  const policyMap = resolvePolicies(policies, schema);
  const rt = createRealtimeServer({
    server: server as HttpServer,
    database: db,
    config: opts.realtime,
    authSecret: SECRET,
    policies: policyMap,
    roleTtlMs: opts.roleTtlMs,
  });

  const alice = await signAccessToken({ id: 1, email: "alice@x.com", role: "admin" }, SECRET, "1h");
  const bob = await signAccessToken({ id: 2, email: "bob@x.com", role: "user" }, SECRET, "1h");
  const carol = await signAccessToken({ id: 3, email: "carol@x.com", role: "user" }, SECRET, "1h");

  return {
    db,
    app,
    server,
    rt,
    port,
    alice,
    bob,
    carol,
    async close() {
      await rt.close();
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

// ─── Socket helpers ──────────────────────────────────────────────

function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/realtime`);
    // Abnormal server-initiated closes (1009 payload, 4008 rate limit, etc.)
    // emit 'error' on the client; swallow them so they don't crash the suite.
    ws.addEventListener("error", () => {});
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function nextMsg(
  ws: WebSocket,
  pred?: (m: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("nextMsg timed out"));
    }, timeoutMs);
    const onMsg = (e: MessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (!pred || pred(m)) {
        cleanup();
        resolve(m);
      }
    };
    const onClose = (ev: CloseEvent) => {
      cleanup();
      reject(new Error(`closed ${ev.code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}

function onClose(ws: WebSocket, timeoutMs = 3000): Promise<CloseEvent> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("close", onDone);
      resolve(new CloseEvent("close", { code: -1 }));
    }, timeoutMs);
    const onDone = (ev: CloseEvent) => {
      clearTimeout(timer);
      resolve(ev);
    };
    ws.addEventListener("close", onDone, { once: true });
  });
}

/** Authenticate a socket and wait for auth:ok. */
async function authenticate(ws: WebSocket, token: string): Promise<void> {
  send(ws, { type: "auth", token });
  const msg = await nextMsg(ws, (m) => m.type === "auth:ok" || m.type === "auth:error");
  assert.equal(msg.type, "auth:ok", `auth failed: ${msg.message ?? ""}`);
}

/** Subscribe + attach an event collector that accumulates matching rows. */
function subscribeAndCollect(
  ws: WebSocket,
  table: string,
  filters?: unknown[]
): { events: any[]; id: string } {
  const id = `sub-${Math.random().toString(36).slice(2)}`;
  const events: any[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(e.data as string);
    } catch {
      return;
    }
    if (m.type === "event" && m.event?.table === table) {
      events.push(m.event);
    }
  });
  send(ws, { type: "subscribe", id, table, filters });
  return { events, id };
}

async function insert(h: Harness, token: string, title: string): Promise<Row> {
  const res = await h.app.request("/api/posts", jsonReq("POST", { title }, bearer(token)));
  const body = (await res.json()) as { data: Row };
  return body.data;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Realtime security contract", () => {
  describe("handshake", () => {
    it("accepts a valid access token", async () => {
      const h = await setup();
      try {
        const ws = await open(h.port);
        await authenticate(ws, h.bob);
        ws.close();
      } finally {
        await h.close();
      }
    });

    it("rejects an invalid token and closes (4001)", async () => {
      const h = await setup();
      try {
        const ws = await open(h.port);
        send(ws, { type: "auth", token: "not-a-jwt" });
        const msg = await nextMsg(ws, (m) => m.type === "auth:error");
        assert.equal(msg.type, "auth:error");
        const ev = await onClose(ws);
        assert.equal(ev.code, 4001);
      } finally {
        await h.close();
      }
    });

    it("closes sockets that never authenticate within the timeout (4002)", async () => {
      const h = await setup({ realtime: { authTimeoutMs: 100 } as RealtimeConfig });
      try {
        const ws = await open(h.port);
        const ev = await onClose(ws);
        assert.equal(ev.code, 4002);
      } finally {
        await h.close();
      }
    });

    it("rejects any non-auth message before authentication (4001)", async () => {
      const h = await setup();
      try {
        const ws = await open(h.port);
        send(ws, { type: "subscribe", id: "x", table: "posts" });
        await nextMsg(ws, (m) => m.type === "auth:error");
        const ev = await onClose(ws);
        assert.equal(ev.code, 4001);
      } finally {
        await h.close();
      }
    });
  });

  describe("owner-scoped visibility", () => {
    it("delivers an insert only to the owning user", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);
        const aColl = subscribeAndCollect(a, "posts");
        const bColl = subscribeAndCollect(b, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");
        await nextMsg(b, (m) => m.type === "subscribed");

        await insert(h, h.alice, "alice's post");
        await insert(h, h.bob, "bob's post");
        await wait(150);

        assert.deepEqual(
          aColl.events.map((e) => e.row.title),
          ["alice's post"],
          "alice must not see bob's insert"
        );
        assert.deepEqual(
          bColl.events.map((e) => e.row.title),
          ["bob's post"],
          "bob must not see alice's insert"
        );
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });

    it("delivers updates only to the owner", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);
        const aColl = subscribeAndCollect(a, "posts");
        const bColl = subscribeAndCollect(b, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");
        await nextMsg(b, (m) => m.type === "subscribed");

        const created = await insert(h, h.alice, "original");
        await wait(120);
        // alice patches her own row.
        await h.app.request(
          `/api/posts/${created.id}`,
          jsonReq("PATCH", { title: "updated" }, bearer(h.alice))
        );
        await wait(150);

        assert.ok(
          aColl.events.some((e) => e.type === "update" && e.row.title === "updated"),
          "owner sees the update"
        );
        assert.equal(
          bColl.events.length,
          0,
          "non-owner must not see the update"
        );
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });

    it("delivers deletes only to the owner", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);
        const aColl = subscribeAndCollect(a, "posts");
        const bColl = subscribeAndCollect(b, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");
        await nextMsg(b, (m) => m.type === "subscribed");

        const created = await insert(h, h.alice, "to-delete");
        await wait(120);
        await h.app.request(`/api/posts/${created.id}`, {
          method: "DELETE",
          headers: bearer(h.alice),
        });
        await wait(150);

        assert.equal(aColl.events.at(-1)?.type, "delete", "owner sees the delete");
        assert.equal(bColl.events.length, 0, "non-owner must not see the delete");
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });

    it("a forged owner filter cannot broaden visibility", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);
        // bob tries to subscribe to alice's rows by forging an owner_id=1 filter.
        const bColl = subscribeAndCollect(b, "posts", [
          { column: "owner_id", operator: "eq", value: 1 },
        ]);
        await nextMsg(b, (m) => m.type === "subscribed");
        subscribeAndCollect(a, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");

        await insert(h, h.alice, "alice private");
        await wait(150);

        assert.equal(
          bColl.events.length,
          0,
          "forged filter must not let bob see alice's rows"
        );
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("system tables", () => {
    it("rejects subscriptions to system tables even when authenticated", async () => {
      const h = await setup();
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        send(ws, { type: "subscribe", id: "sys", table: "_users" });
        const msg = await nextMsg(ws, (m) => m.type === "error");
        assert.match(msg.message, /System tables/);
        ws.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("admin bypass + demotion", () => {
    it("adminBypass lets an admin receive every row", async () => {
      const h = await setup({
        policies: { posts: { ownerColumn: "owner_id", adminBypass: true } },
      });
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);
        const aColl = subscribeAndCollect(a, "posts");
        subscribeAndCollect(b, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");
        await nextMsg(b, (m) => m.type === "subscribed");

        await insert(h, h.bob, "bob's post");
        await wait(150);

        assert.equal(
          aColl.events.length,
          1,
          "admin with bypass sees bob's row too"
        );
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });

    it("demoting an admin revokes bypass without waiting for JWT expiry", async () => {
      const h = await setup({
        policies: { posts: { ownerColumn: "owner_id", adminBypass: true } },
        roleTtlMs: 0,
      });
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const aColl = subscribeAndCollect(a, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");

        // While still admin, alice sees bob's insert (bypass).
        await insert(h, h.bob, "while-admin");
        await wait(120);
        assert.equal(aColl.events.length, 1, "admin saw the row before demotion");

        // Demote alice to a regular user. roleTtlMs=0 forces a live re-read on
        // the next event delivery, so bypass is revoked immediately.
        h.db.sqliteRaw().prepare(`UPDATE "_users" SET "role"='user' WHERE "id"=1`).run();
        await insert(h, h.bob, "after-demotion");
        await wait(150);

        assert.equal(
          aColl.events.length,
          1,
          "demoted admin must not receive others' rows anymore"
        );
        a.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("replay isolation", () => {
    it("replay applies owner scope: a reconnecting user gets only their own buffered events", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        subscribeAndCollect(a, "posts");
        await nextMsg(a, (m) => m.type === "subscribed");

        // Capture alice's cursor from a live event.
        await insert(h, h.alice, "alice live");
        const liveEv: any = await nextMsg(a, (m) => m.type === "event");
        const cursor = liveEv.event.cursor;
        assert.ok(typeof cursor === "string");
        a.close();
        await wait(50);

        // While alice is offline, both alice-owned and carol-owned rows are
        // inserted. (Use db.insert so change events enter the replay buffer.)
        await h.db.insert("posts", { title: "alice offline", owner_id: 1 });
        await h.db.insert("posts", { title: "carol offline", owner_id: 3 });

        // Reconnect alice with the captured cursor.
        const a2 = await open(h.port); await authenticate(a2, h.alice);
        const replayed: any[] = [];
        a2.addEventListener("message", (e: MessageEvent) => {
          const m = JSON.parse(e.data as string);
          if (m.type === "event") replayed.push(m.event);
        });
        send(a2, { type: "subscribe", id: "replay-sub", table: "posts", cursor });
        await nextMsg(a2, (m) => m.type === "subscribed");
        await wait(150);

        assert.deepEqual(
          replayed.map((ev) => ev.row.title),
          ["alice offline"],
          "replay must not leak other users' buffered events"
        );
        a2.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("resync-required", () => {
    it("is sent when the server epoch changed (restart)", async () => {
      const h = await setup();
      let staleCursor: string;
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        subscribeAndCollect(ws, "posts");
        await nextMsg(ws, (m) => m.type === "subscribed");
        await insert(h, h.bob, "seed");
        const ev: any = await nextMsg(ws, (m) => m.type === "event");
        staleCursor = ev.event.cursor;
        ws.close();
      } finally {
        await h.close();
      }

      // A brand-new realtime server on the same DB has a new epoch. Replaying
      // the stale cursor must yield resync:required, not a partial history.
      const db = await Database.open({ path: ":memory:", schema, auth: authConfig });
      const app = createServer(db, schema, { auth: authConfig, policies: POLICY });
      const server = serve({ fetch: app.fetch, port: 0 });
      const port = (server.address() as { port: number }).port;
      const rt = createRealtimeServer({
        server: server as HttpServer,
        database: db,
        authSecret: SECRET,
        policies: resolvePolicies(POLICY, schema),
      });
      try {
        const ws = await open(port); await authenticate(ws, h.bob);
        send(ws, { type: "subscribe", id: "r", table: "posts", cursor: staleCursor });
        const msg = await nextMsg(ws, (m) => m.type === "resync:required");
        assert.equal(msg.type, "resync:required");
        assert.equal(msg.reason, "server_restarted");
        ws.close();
      } finally {
        await rt.close();
        await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
        await db.close();
      }
    });

    it("is sent when the requested event fell out of the buffer", async () => {
      const h = await setup({ realtime: { eventLogSize: 2 } as RealtimeConfig });
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        subscribeAndCollect(ws, "posts");
        await nextMsg(ws, (m) => m.type === "subscribed");

        await insert(h, h.bob, "old");
        const oldEv: any = await nextMsg(ws, (m) => m.type === "event");
        const staleCursor = oldEv.event.cursor;

        // Push enough new events to evict the old one from the size-2 buffer.
        await h.db.insert("posts", { title: "n1", owner_id: 2 });
        await h.db.insert("posts", { title: "n2", owner_id: 2 });
        await h.db.insert("posts", { title: "n3", owner_id: 2 });

        send(ws, { type: "subscribe", id: "r2", table: "posts", cursor: staleCursor });
        const msg = await nextMsg(ws, (m) => m.type === "resync:required");
        assert.equal(msg.reason, "buffer_evicted");
        ws.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("presence (authenticated)", () => {
    it("derives presence identity from the authenticated principal", async () => {
      const h = await setup();
      try {
        const a = await open(h.port); await authenticate(a, h.alice);
        const b = await open(h.port); await authenticate(b, h.bob);

        // alice tries to impersonate by passing key "bob".
        send(a, { type: "presence:join", channel: "room", key: "impostor", metadata: { x: 1 } });
        await nextMsg(a, (m) => m.type === "presence");
        // bob joins the same channel and receives alice's presence state.
        send(b, { type: "presence:join", channel: "room", key: "b", metadata: {} });
        const bobSync: any = await nextMsg(b, (m) => m.type === "presence" && m.event?.type === "sync");
        const aliceEntry = (bobSync.event.states as any[]).find(
          (s) => s.metadata && s.metadata.x === 1
        );
        assert.ok(aliceEntry, "bob sees alice's presence");
        assert.equal(
          aliceEntry.key,
          "1",
          "presence key must be the verified user id, not the client-supplied impostor"
        );
        a.close(); b.close();
      } finally {
        await h.close();
      }
    });

    it("rejects oversized presence metadata", async () => {
      const h = await setup({
        realtime: { limits: { maxPresenceMetadataBytes: 8 } } as RealtimeConfig,
      });
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        send(ws, {
          type: "presence:join",
          channel: "room",
          key: "bob",
          metadata: { big: "this is way too large for the 8-byte cap" },
        });
        const msg = await nextMsg(ws, (m) => m.type === "error");
        assert.match(msg.message, /metadata too large/i);
        ws.close();
      } finally {
        await h.close();
      }
    });
  });

  describe("limits", () => {
    it("caps subscriptions per socket", async () => {
      const h = await setup({
        realtime: { limits: { maxSubscriptionsPerSocket: 2 } } as RealtimeConfig,
      });
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        send(ws, { type: "subscribe", id: "s1", table: "tags" });
        send(ws, { type: "subscribe", id: "s2", table: "posts" });
        await nextMsg(ws, (m) => m.type === "subscribed");
        send(ws, { type: "subscribe", id: "s3", table: "tags" });
        const msg = await nextMsg(ws, (m) => m.type === "error");
        assert.match(msg.message, /limit/i);
        ws.close();
      } finally {
        await h.close();
      }
    });

    it("rejects oversized inbound frames", async () => {
      const h = await setup({
        realtime: { limits: { maxPayloadBytes: 64 } } as RealtimeConfig,
      });
      try {
        const ws = await open(h.port);
        ws.addEventListener("error", () => {}); // swallow abnormal-close errors
        // A frame larger than maxPayloadBytes must close the socket, even
        // before authentication completes.
        const huge = "x".repeat(10_000);
        ws.send(
          JSON.stringify({
            type: "subscribe",
            id: "big",
            table: "tags",
            filters: [{ column: huge, operator: "eq", value: huge }],
          })
        );
        const ev = await onClose(ws);
        assert.notEqual(ev.code, 1000, "oversized frame must close the socket");
        assert.notEqual(ev.code, -1, "socket should have closed, not timed out");
      } finally {
        await h.close();
      }
    });

    it("closes sockets that flood messages above the rate limit", async () => {
      const h = await setup({
        realtime: { limits: { maxMessagesPerSecond: 2 } } as RealtimeConfig,
      });
      try {
        const ws = await open(h.port); await authenticate(ws, h.bob);
        // Flood well beyond the 2 msg/s budget.
        for (let i = 0; i < 50; i++) {
          ws.send(JSON.stringify({ type: "subscribe", id: `f${i}`, table: "tags" }));
        }
        const ev = await onClose(ws);
        assert.equal(ev.code, 4008, "rate-limited socket must be closed");
      } finally {
        await h.close();
      }
    });
  });
});
