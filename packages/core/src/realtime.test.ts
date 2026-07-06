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

    before(() => {
      db = new Database({ schema: testSchema });
    });

    after(() => {
      db.close();
    });

    it("emits insert events", async () => {
      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      db.insert("messages", { room_id: 1, body: "hello" });

      assert.equal(events.length, 1);
      const e = events[0] as { type: string; table: string; row: Record<string, unknown> };
      assert.equal(e.type, "insert");
      assert.equal(e.table, "messages");
      assert.equal(e.row.body, "hello");
      assert.ok(e.row.id);
    });

    it("emits update events", async () => {
      const inserted = db.insert("messages", { room_id: 1, body: "original" });
      const id = (inserted[0] as Record<string, unknown>).id;

      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      db.update("messages", { body: "updated" }, [{ column: "id", operator: "eq", value: id }]);

      assert.equal(events.length, 1);
      const e = events[0] as { type: string; row: Record<string, unknown> };
      assert.equal(e.type, "update");
      assert.equal(e.row.body, "updated");
    });

    it("emits delete events", async () => {
      const inserted = db.insert("messages", { room_id: 1, body: "to delete" });
      const id = (inserted[0] as Record<string, unknown>).id;

      const events: unknown[] = [];
      db.on("change", (event) => events.push(event));

      db.delete("messages", [{ column: "id", operator: "eq", value: id }]);

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
      db = new Database({ schema: testSchema });
      app = createServer(db, testSchema);
      server = serve({ fetch: app.fetch, port: 0 });
      port = (server.address() as { port: number }).port;
      realtime = createRealtimeServer({ server: server as HttpServer, database: db });
    });

    after(async () => {
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
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

      db.insert("messages", { room_id: 1, body: "broadcast" });

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

      db.insert("messages", { room_id: 1, body: "room one" });
      db.insert("messages", { room_id: 2, body: "room two" });

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

      db.insert("messages", { room_id: 1, body: "not for me" });

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
      db.insert("messages", { room_id: 1, body: "before disconnect" });
      const firstMessage = await firstMessagePromise;
      const firstEvent = (firstMessage as { event: { id: number } }).event;
      firstSocket.close();

      db.insert("messages", { room_id: 1, body: "while disconnected" });

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
});
