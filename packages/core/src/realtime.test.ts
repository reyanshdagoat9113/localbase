import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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
      realtime = createRealtimeServer({ server, database: db });
    });

    after(() => {
      realtime.close();
      server.close();
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
        server: disabledServer,
        database: db,
        config: { enabled: false },
      });

      const socket = new WebSocket(`ws://localhost:${disabledPort}/realtime`);
      await assert.rejects(() => waitForSocket(socket, WebSocket.OPEN), /WebSocket error/);

      socket.close();
      await disabledRealtime.close();
      disabledServer.close();
    });
  });
});
