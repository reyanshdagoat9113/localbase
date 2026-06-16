import type { WebSocket } from "ws";
import type {
  PresenceEvent,
  PresenceState,
  RealtimeEvent,
  RealtimeFilter,
} from "@localbase/shared";
import { rowMatchesFilters } from "./filter.js";

export interface ClientSubscription {
  table: string;
  filters: RealtimeFilter[];
}

interface ClientState {
  socket: WebSocket;
  subscriptions: Map<string, ClientSubscription>;
  presence: Map<string, PresenceState>;
}

/**
 * Tracks active WebSocket subscriptions and routes realtime events to the
 * clients whose filters match the changed row.
 */
export class SubscriptionManager {
  private clients = new Map<WebSocket, ClientState>();

  addClient(socket: WebSocket): void {
    this.clients.set(socket, {
      socket,
      subscriptions: new Map(),
      presence: new Map(),
    });
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
    for (const client of this.clients.values()) {
      for (const sub of client.subscriptions.values()) {
        if (this.matchesSubscription(event, sub)) {
          this.send(client.socket, { type: "event", event });
        }
      }
    }
  }

  replay(socket: WebSocket, events: RealtimeEvent[]): void {
    const client = this.clients.get(socket);
    if (!client) return;

    for (const event of events) {
      for (const sub of client.subscriptions.values()) {
        if (this.matchesSubscription(event, sub)) {
          this.send(socket, { type: "event", event });
          break;
        }
      }
    }
  }

  joinPresence(
    socket: WebSocket,
    channel: string,
    key: string,
    metadata?: unknown
  ): void {
    const client = this.clients.get(socket);
    if (!client) return;

    const now = new Date().toISOString();
    const existing = client.presence.get(presenceId(channel, key));
    const state: PresenceState = {
      channel,
      key,
      metadata,
      joinedAt: existing?.joinedAt ?? now,
      updatedAt: now,
    };

    client.presence.set(presenceId(channel, key), state);
    this.send(socket, {
      type: "presence",
      event: {
        type: "sync",
        channel,
        states: this.getPresence(channel),
      } satisfies PresenceEvent,
    });
    this.broadcastPresence(socket, {
      type: existing ? "update" : "join",
      channel,
      key,
      state,
    });
  }

  leavePresence(socket: WebSocket, channel: string, key?: string): void {
    const client = this.clients.get(socket);
    if (!client) return;

    const entries = [...client.presence.values()].filter(
      (state) => state.channel === channel && (key === undefined || state.key === key)
    );

    for (const state of entries) {
      client.presence.delete(presenceId(state.channel, state.key));
      this.broadcastPresence(socket, {
        type: "leave",
        channel: state.channel,
        key: state.key,
      });
    }
  }

  leaveAllPresence(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (!client) return;

    for (const state of client.presence.values()) {
      this.broadcastPresence(socket, {
        type: "leave",
        channel: state.channel,
        key: state.key,
      });
    }
    client.presence.clear();
  }

  getPresence(channel: string): PresenceState[] {
    const states: PresenceState[] = [];
    for (const client of this.clients.values()) {
      for (const state of client.presence.values()) {
        if (state.channel === channel) {
          states.push(state);
        }
      }
    }
    return states;
  }

  private matchesSubscription(
    event: RealtimeEvent,
    subscription: ClientSubscription
  ): boolean {
    const row = event.row as Record<string, unknown> | undefined;
    if (subscription.table !== event.table) return false;
    if (row === undefined) return false;
    return (
      subscription.filters.length === 0 ||
      rowMatchesFilters(row, subscription.filters)
    );
  }

  private broadcastPresence(source: WebSocket, event: PresenceEvent): void {
    for (const client of this.clients.values()) {
      if (client.socket === source) continue;
      const inChannel = [...client.presence.values()].some(
        (state) => state.channel === event.channel
      );
      if (inChannel) {
        this.send(client.socket, { type: "presence", event });
      }
    }
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === 1 /* OPEN */) {
      socket.send(JSON.stringify(payload));
    }
  }
}

function presenceId(channel: string, key: string): string {
  return `${channel}:${key}`;
}
