import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { Database, createServer, createRealtimeServer } from "./index.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { RealtimeServer } from "./realtime/index.js";

const testSchema: DatabaseSchema = {
  messages: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    room_id: { type: "integer" },
    body: { type: "text", nullable: false },
  },
};

function waitForSocket(socket: WebSocket, state: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === state) {
      resolve();
      return;
    }
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket error"));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try {
        resolve(JSON.parse(event.data as string));
      } catch (err) {
        reject(err);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before message"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: unknown) => boolean
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      let message: unknown;
      try {
        message = JSON.parse(event.data as string);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before message"));
    };
    const cleanup = () => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

describe("Realtime", () => {
  describe("Database events", () => {
    let db: Database;

    before(async () => {
      db = await Database.open({ schema: testSchema });
    });

    after(async () => {
      await db.close();
    });

    it("emits insert events", async () => {
      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      await db.insert("messages", { room_id: 1, body: "hello" });

      assert.equal(events.length, 1);
      const e = events[0] as { type: string; table: string; row: Record<string, unknown> };
      assert.equal(e.type, "insert");
      assert.equal(e.table, "messages");
      assert.equal(e.row.body, "hello");
      assert.ok(e.row.id);
    });

    it("emits update events", async () => {
      const inserted = await db.insert("messages", { room_id: 1, body: "original" });
      const id = (inserted[0] as Record<string, unknown>).id;

      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      await db.update("messages", { body: "updated" }, [{ column: "id", operator: "eq", value: id }]);

      assert.equal(events.length, 1);
      const e = events[0] as { type: string; row: Record<string, unknown> };
      assert.equal(e.type, "update");
      assert.equal(e.row.body, "updated");
    });

    it("emits delete events", async () => {
      const inserted = await db.insert("messages", { room_id: 1, body: "to delete" });
      const id = (inserted[0] as Record<string, unknown>).id;

      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      await db.delete("messages", [{ column: "id", operator: "eq", value: id }]);

      assert.equal(events.length, 1);
      const e = events[0] as { type: string; row: Record<string, unknown> };
      assert.equal(e.type, "delete");
      assert.equal(e.row.body, "to delete");
    });
  });

  describe("WebSocket server", () => {
    let db: Database;
    let app: ReturnType<typeof createServer>;
    let server: ReturnType<typeof serve>;
    let realtime: RealtimeServer;
    let port: number;

    before(async () => {
      db = await Database.open({ schema: testSchema });
      app = createServer(db, testSchema, { auth: { enabled: false } });
      server = serve({ fetch: app.fetch, port: 0 });
      port = (server.address() as { port: number }).port;
      realtime = createRealtimeServer({ server: server as HttpServer, database: db });
    });

    after(async () => {
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await db.close();
    });

    it("broadcasts insert events to subscribed clients", async () => {
      const socket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(socket, WebSocket.OPEN);

      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "sub-1",
          table: "messages",
        })
      );

      const ack = await nextMessage(socket);
      assert.equal((ack as { type: string }).type, "subscribed");

      await db.insert("messages", { room_id: 1, body: "broadcast" });

      const msg = await nextMessage(socket);
      const event = (msg as { event: { type: string; table: string; row: Record<string, unknown> } }).event;
      assert.equal(event.type, "insert");
      assert.equal(event.table, "messages");
      assert.equal(event.row.body, "broadcast");

      socket.close();
    });

    it("rejects subscriptions to system tables", async () => {
      const socket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(socket, WebSocket.OPEN);

      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "system-table-sub",
          table: "_job_runs",
        })
      );

      const response = await nextMessage(socket);
      assert.deepEqual(response, {
        type: "error",
        message: "System tables are not subscribable",
      });

      socket.close();
    });

    it("filters events by subscription filters", async () => {
      const socket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(socket, WebSocket.OPEN);

      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "sub-room-2",
          table: "messages",
          filters: [{ column: "room_id", operator: "eq", value: 2 }],
        })
      );

      await nextMessage(socket); // subscribed ack

      await db.insert("messages", { room_id: 1, body: "room one" });
      await db.insert("messages", { room_id: 2, body: "room two" });

      const msg = await nextMessage(socket);
      const event = (msg as { event: { row: Record<string, unknown> } }).event;
      assert.equal(event.row.body, "room two");

      socket.close();
    });

    it("does not send events for unsubscribed tables", async () => {
      const socket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(socket, WebSocket.OPEN);

      socket.send(
        JSON.stringify({
          type: "subscribe",
          id: "sub-other",
          table: "other_table",
        })
      );

      await nextMessage(socket); // subscribed ack

      await db.insert("messages", { room_id: 1, body: "not for me" });

      // Give it a moment, then assert no message arrived.
      const race = await Promise.race([
        nextMessage(socket),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
      ]);
      assert.equal(race, "timeout");

      socket.close();
    });

    it("does not expose a websocket endpoint when realtime is disabled", async () => {
      const disabledServer = serve({ fetch: app.fetch, port: 0 });
      const disabledPort = (disabledServer.address() as { port: number }).port;
      const disabledRealtime = createRealtimeServer({
        server: disabledServer as HttpServer,
        database: db,
        config: { enabled: false },
      });

      const socket = new WebSocket(`ws://localhost:${disabledPort}/realtime`);
      await assert.rejects(() => waitForSocket(socket, WebSocket.OPEN), /WebSocket error/);

      socket.close();
      await disabledRealtime.close();
      disabledServer.close();
    });

    it("replays buffered events missed since the client's last event id", async () => {
      const firstSocket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(firstSocket, WebSocket.OPEN);

      firstSocket.send(
        JSON.stringify({
          type: "subscribe",
          id: "replay-1",
          table: "messages",
        })
      );
      await nextMessage(firstSocket);

      const firstMessagePromise = nextMessage(firstSocket);
      await db.insert("messages", { room_id: 1, body: "before disconnect" });
      const firstMessage = await firstMessagePromise;
      const firstEvent = (firstMessage as { event: { id: number } }).event;
      firstSocket.close();

      await db.insert("messages", { room_id: 1, body: "while disconnected" });

      const secondSocket = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(secondSocket, WebSocket.OPEN);
      const replayPromise = waitForMessage(
        secondSocket,
        (message) => (message as { type?: string }).type === "event"
      );
      secondSocket.send(
        JSON.stringify({
          type: "subscribe",
          id: "replay-2",
          table: "messages",
          lastEventId: firstEvent.id,
        })
      );
      await nextMessage(secondSocket);

      const replay = await replayPromise;
      const replayEvent = (replay as {
        event: { type: string; row: Record<string, unknown> };
      }).event;
      assert.equal(replayEvent.type, "insert");
      assert.equal(replayEvent.row.body, "while disconnected");

      secondSocket.close();
    });

    it("tracks presence join, sync, update, and leave events", async () => {
      const alice = new WebSocket(`ws://localhost:${port}/realtime`);
      const bob = new WebSocket(`ws://localhost:${port}/realtime`);
      await waitForSocket(alice, WebSocket.OPEN);
      await waitForSocket(bob, WebSocket.OPEN);

      alice.send(
        JSON.stringify({
          type: "presence:join",
          channel: "room:1",
          key: "alice",
          metadata: { name: "Alice" },
        })
      );
      const aliceSync = await nextMessage(alice);
      assert.equal((aliceSync as { event: { type: string } }).event.type, "sync");

      bob.send(
        JSON.stringify({
          type: "presence:join",
          channel: "room:1",
          key: "bob",
          metadata: { name: "Bob" },
        })
      );
      const bobSync = await nextMessage(bob);
      const syncStates = (bobSync as { event: { states: unknown[] } }).event.states;
      assert.equal(syncStates.length, 2);

      const bobJoin = await nextMessage(alice);
      assert.equal((bobJoin as { event: { type: string; key: string } }).event.type, "join");
      assert.equal((bobJoin as { event: { key: string } }).event.key, "bob");

      bob.send(
        JSON.stringify({
          type: "presence:join",
          channel: "room:1",
          key: "bob",
          metadata: { name: "Bobby" },
        })
      );
      await nextMessage(bob); // updated sync
      const update = await nextMessage(alice);
      assert.equal((update as { event: { type: string; key: string } }).event.type, "update");

      bob.close();
      const leave = await nextMessage(alice);
      assert.equal((leave as { event: { type: string; key: string } }).event.type, "leave");
      assert.equal((leave as { event: { key: string } }).event.key, "bob");

      alice.close();
    });
  });

  describe("SubscriptionManager per-client async delivery ordering", () => {
    it("delivers events in order even when an earlier event awaits a slow role-cache refresh", async () => {
      const { SubscriptionManager } = await import("./realtime/subscription-manager.js");
      const policyMap = new Map([
        ["notes", { table: "notes", ownerColumn: "user_id", adminBypass: true }],
      ]);

      let lookupCount = 0;
      const fakeDb = {
        async selectById(_table: string, _id: number) {
          lookupCount++;
          // First lookup (subscribe) is fast; second lookup (event #1 refresh) is slow;
          // third lookup (event #2) would overtake #1 if delivery weren't serialized.
          if (lookupCount === 2) {
            await new Promise((r) => setTimeout(r, 40));
          }
          return { id: 1, role: "admin" };
        },
      } as unknown as Database;

      const sent: number[] = [];
      const fakeSocket = {
        readyState: 1,
        bufferedAmount: 0,
        send(payload: string) {
          const parsed = JSON.parse(payload) as { event?: { id?: number } };
          if (parsed.event?.id !== undefined) sent.push(parsed.event.id);
        },
      } as unknown as WebSocket;

      const mgr = new SubscriptionManager({
        database: fakeDb,
        policyMap,
        roleTtlMs: 0, // force a role lookup on every event
      });
      mgr.addClient(fakeSocket, { id: 1, email: "admin@test.com", role: "admin" });
      const sub = await mgr.subscribe(fakeSocket, "s1", "notes", []);
      assert.equal(sub.ok, true);

      const p1 = mgr.broadcast({
        type: "insert",
        table: "notes",
        row: { id: 1, user_id: 99, title: "first" },
        id: 1,
      });
      const p2 = mgr.broadcast({
        type: "insert",
        table: "notes",
        row: { id: 2, user_id: 99, title: "second" },
        id: 2,
      });

      await Promise.all([p1, p2]);
      assert.deepEqual(sent, [1, 2]);
    });
  });
});
