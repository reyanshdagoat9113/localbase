import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import type { Database } from "../db.js";
import type { RealtimeConfig, RealtimeEvent, RealtimeFilter } from "@localbase/shared";
import { SubscriptionManager } from "./subscription-manager.js";

export interface RealtimeServerOptions {
  /** HTTP/HTTPS server to attach the WebSocket server to. */
  server: HttpServer | HttpsServer;
  /** LocalBase database instance to listen for changes on. */
  database: Database;
  /** Realtime configuration. */
  config?: RealtimeConfig;
}

export interface RealtimeServer {
  wss: WebSocketServer;
  subscriptions: SubscriptionManager;
  close(): Promise<void>;
}

interface SubscribeMessage {
  type: "subscribe";
  id?: string;
  table: string;
  filters?: unknown[];
  lastEventId?: number;
}

interface UnsubscribeMessage {
  type: "unsubscribe";
  id: string;
}

interface PresenceJoinMessage {
  type: "presence:join";
  channel: string;
  key: string;
  metadata?: unknown;
}

interface PresenceLeaveMessage {
  type: "presence:leave";
  channel: string;
  key?: string;
}

/**
 * Attach a WebSocket realtime server to an existing HTTP server.
 *
 * Clients send messages like:
 *   { type: "subscribe", table: "messages", filters: [{column:"room_id",operator:"eq",value:1}] }
 *   { type: "unsubscribe", id: "<subscription-id>" }
 *
 * The server replies with:
 *   { type: "event", event: { type: "insert", table: "messages", row: {...} } }
 */
export function createRealtimeServer(
  options: RealtimeServerOptions
): RealtimeServer {
  const { server, database, config } = options;
  if (config?.enabled === false) {
    const wss = new WebSocketServer({ noServer: true });
    return {
      wss,
      subscriptions: new SubscriptionManager(),
      async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
          wss.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
    };
  }

  const path = config?.path ?? "/realtime";
  const eventLogSize = config?.eventLogSize ?? 1000;
  const presenceEnabled = config?.presence ?? true;

  const wss = new WebSocketServer({ server, path });
  const subscriptions = new SubscriptionManager();
  const eventLog: RealtimeEvent[] = [];
  let nextEventId = 1;

  // Forward database change events to matching subscribers.
  function onDatabaseChange(event: RealtimeEvent) {
    const loggedEvent: RealtimeEvent = {
      ...event,
      id: nextEventId++,
      timestamp: new Date().toISOString(),
    };
    eventLog.push(loggedEvent);
    if (eventLog.length > eventLogSize) {
      eventLog.splice(0, eventLog.length - eventLogSize);
    }
    subscriptions.broadcast(loggedEvent);
  }

  database.on("change", onDatabaseChange);

  wss.on("connection", (socket: WebSocket) => {
    subscriptions.addClient(socket);

    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (!isRealtimeMessage(message)) {
        socket.send(
          JSON.stringify({ type: "error", message: "Unknown message type" })
        );
        return;
      }

      if (message.type === "subscribe") {
        const id = message.id ?? generateId();
        const filters = normalizeFilters(message.filters);
        subscriptions.subscribe(socket, id, message.table, filters);
        socket.send(JSON.stringify({ type: "subscribed", id, table: message.table }));
        const lastEventId = message.lastEventId;
        if (typeof lastEventId === "number") {
          subscriptions.replay(
            socket,
            eventLog.filter((event) => (event.id ?? 0) > lastEventId)
          );
        }
      } else if (message.type === "unsubscribe") {
        subscriptions.unsubscribe(socket, message.id);
        socket.send(JSON.stringify({ type: "unsubscribed", id: message.id }));
      } else if (message.type === "presence:join") {
        if (!presenceEnabled) {
          socket.send(JSON.stringify({ type: "error", message: "Presence disabled" }));
          return;
        }
        subscriptions.joinPresence(
          socket,
          message.channel,
          message.key,
          message.metadata
        );
      } else if (message.type === "presence:leave") {
        subscriptions.leavePresence(socket, message.channel, message.key);
      }
    });

    socket.on("close", () => {
      subscriptions.leaveAllPresence(socket);
      subscriptions.unsubscribeAll(socket);
      subscriptions.removeClient(socket);
    });

    socket.on("error", () => {
      subscriptions.leaveAllPresence(socket);
      subscriptions.unsubscribeAll(socket);
      subscriptions.removeClient(socket);
    });
  });

  return {
    wss,
    subscriptions,
    close(): Promise<void> {
      database.off("change", onDatabaseChange);
      // Forcibly terminate any lingering client connections so the underlying
      // HTTP server can shut down promptly.
      for (const client of wss.clients) {
        client.terminate();
      }
      return new Promise((resolve, reject) => {
        wss.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function isRealtimeMessage(
  msg: unknown
): msg is SubscribeMessage | UnsubscribeMessage | PresenceJoinMessage | PresenceLeaveMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type === "subscribe") {
    return typeof m.table === "string";
  }
  if (m.type === "unsubscribe") {
    return typeof m.id === "string";
  }
  if (m.type === "presence:join") {
    return typeof m.channel === "string" && typeof m.key === "string";
  }
  if (m.type === "presence:leave") {
    return (
      typeof m.channel === "string" &&
      (m.key === undefined || typeof m.key === "string")
    );
  }
  return false;
}

function normalizeFilters(filters: unknown[] | undefined): RealtimeFilter[] {
  if (!Array.isArray(filters)) return [];
  const result: RealtimeFilter[] = [];
  for (const f of filters) {
    if (
      typeof f === "object" &&
      f !== null &&
      "column" in f &&
      "operator" in f &&
      "value" in f
    ) {
      const filter = f as { column: unknown; operator: unknown; value: unknown };
      if (
        typeof filter.column === "string" &&
        typeof filter.operator === "string"
      ) {
        result.push({
          column: filter.column,
          operator: filter.operator as RealtimeFilter["operator"],
          value: filter.value,
        });
      }
    }
  }
  return result;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
