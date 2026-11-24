import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { Database, createServer, createRealtimeServer } from "@localbase/core";
import type { DatabaseSchema, RealtimeServer } from "@localbase/core";
import { createClient } from "./client.js";
import type { LocalBaseClient } from "./client.js";

const testSchema: DatabaseSchema = {
  messages: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    room_id: { type: "integer" },
    body: { type: "text", nullable: false },
  },
};

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate());
}

describe("SDK realtime", () => {
  let server: ReturnType<typeof serve>;
  let realtime: RealtimeServer;
  let db: Database;
  let client: LocalBaseClient;
  let port: number;

  before(async () => {
    db = await Database.open({ schema: testSchema });
    const app = createServer(db, testSchema);
    server = serve({ fetch: app.fetch, port: 0 });
    port = (server.address() as { port: number }).port;
    realtime = createRealtimeServer({ server: server as HttpServer, database: db });
    client = createClient(`http://localhost:${port}`);
  });

  after(async () => {
    await realtime.close();
    if (
      "closeAllConnections" in server &&
      typeof server.closeAllConnections === "function"
    ) {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.close();
  });

  it("receives insert events", async () => {
    const events: unknown[] = [];
    const unsubscribe = client.subscribe("messages", (event) => {
      events.push(event);
    });

    // Wait a tick for the WebSocket to connect and subscribe.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await db.insert("messages", { room_id: 1, body: "sdk test" });

    // Wait for the event to arrive.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(events.length, 1);
    const e = events[0] as { type: string; table: string; row: Record<string, unknown> };
    assert.equal(e.type, "insert");
    assert.equal(e.table, "messages");
    assert.equal(e.row.body, "sdk test");

    unsubscribe();
  });

  it("filters events with where clause", async () => {
    const events: unknown[] = [];
    const unsubscribe = client.subscribe(
      "messages",
      { where: { room_id: 2 } },
      (event) => events.push(event)
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    await db.insert("messages", { room_id: 1, body: "room one" });
    await db.insert("messages", { room_id: 2, body: "room two" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(events.length, 1);
    const e = events[0] as { row: Record<string, unknown> };
    assert.equal(e.row.body, "room two");

    unsubscribe();
  });

  it("unsubscribe stops receiving events", async () => {
    const events: unknown[] = [];
    const unsubscribe = client.subscribe("messages", (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await db.insert("messages", { room_id: 1, body: "after unsub" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(events.length, 0);
  });

  it("uses the configured realtime path", async () => {
    const customApp = createServer(db, testSchema);
    const customServer = serve({ fetch: customApp.fetch, port: 0 });
    const customPort = (customServer.address() as { port: number }).port;
    const customRealtime = createRealtimeServer({
      server: customServer as HttpServer,
      database: db,
      config: { path: "/ws" },
    });
    const customClient = createClient(`http://localhost:${customPort}`, {
      realtime: { path: "/ws" },
    });

    const events: unknown[] = [];
    const unsubscribe = customClient.subscribe("messages", (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.insert("messages", { room_id: 1, body: "custom path" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(events.length, 1);
    unsubscribe();
    await customRealtime.close();
    await new Promise<void>((resolve, reject) => {
      customServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("does not connect when realtime is disabled in the client", async () => {
    const disabledClient = createClient(`http://localhost:${port}`, {
      realtime: { enabled: false },
    });
    const events: unknown[] = [];
    const unsubscribe = disabledClient.subscribe("messages", (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.insert("messages", { room_id: 1, body: "disabled client" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(events.length, 0);
    unsubscribe();
  });

  it("receives presence events", async () => {
    const aliceEvents: unknown[] = [];
    const bobEvents: unknown[] = [];
    const aliceClient = createClient(`http://localhost:${port}`);
    const bobClient = createClient(`http://localhost:${port}`);

    const alice = aliceClient.presence(
      "room:1",
      "alice",
      { name: "Alice" },
      (event) => aliceEvents.push(event)
    );
    let bob: { update(metadata: { name: string }): void; leave(): void } | undefined;

    try {
      await waitUntil(() =>
        aliceEvents.some((event) => (event as { type: string }).type === "sync")
      );

      bob = bobClient.presence(
        "room:1",
        "bob",
        { name: "Bob" },
        (event) => bobEvents.push(event)
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.ok(
        bobEvents.some(
          (event) =>
            (event as { type: string; states?: unknown[] }).type === "sync" &&
            ((event as { states?: unknown[] }).states?.length ?? 0) >= 2
        )
      );
      assert.ok(
        aliceEvents.some(
          (event) => (event as { type: string; key?: string }).type === "join"
        )
      );

      bob.leave();
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.ok(
        aliceEvents.some(
          (event) =>
            (event as { type: string; key?: string }).type === "leave" &&
            (event as { key?: string }).key === "bob"
        )
      );
    } finally {
      bob?.leave();
      alice.leave();
    }
  });
});
