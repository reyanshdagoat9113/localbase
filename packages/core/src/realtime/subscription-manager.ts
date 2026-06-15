import type { WebSocket } from "ws";
import type { RealtimeEvent, RealtimeFilter } from "@localbase/shared";
import { rowMatchesFilters } from "./filter.js";

export interface ClientSubscription {
  table: string;
  filters: RealtimeFilter[];
}

interface ClientState {
  socket: WebSocket;
  subscriptions: Map<string, ClientSubscription>;
}

/**
 * Tracks active WebSocket subscriptions and routes realtime events to the
 * clients whose filters match the changed row.
 */
export class SubscriptionManager {
  private clients = new Map<WebSocket, ClientState>();

  addClient(socket: WebSocket): void {
    this.clients.set(socket, { socket, subscriptions: new Map() });
  }

  removeClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  subscribe(
    socket: WebSocket,
    subscriptionId: string,
    table: string,
    filters: RealtimeFilter[]
  ): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.subscriptions.set(subscriptionId, { table, filters });
  }

  unsubscribe(socket: WebSocket, subscriptionId: string): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.subscriptions.delete(subscriptionId);
  }

  unsubscribeAll(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.subscriptions.clear();
  }

  broadcast(event: RealtimeEvent): void {
    const row = event.row as Record<string, unknown> | undefined;

    for (const client of this.clients.values()) {
      for (const sub of client.subscriptions.values()) {
        if (sub.table !== event.table) continue;
        if (row === undefined) continue;
        if (sub.filters.length > 0 && !rowMatchesFilters(row, sub.filters)) {
          continue;
        }

        if (client.socket.readyState === 1 /* OPEN */) {
          client.socket.send(
            JSON.stringify({ type: "event", event })
          );
        }
      }
    }
  }
}
