import type { RealtimeEvent, RealtimeFilter } from "@localbase/shared";

export type RealtimeCallback<T = unknown> = (event: RealtimeEvent<T>) => void;

export interface SubscribeOptions {
  /** Simple key/value equality filters. */
  where?: Record<string, unknown>;
  /** Full filter list (overrides `where` when present). */
  filters?: RealtimeFilter[];
}

interface Subscription {
  id: string;
  table: string;
  filters: RealtimeFilter[];
  callback: RealtimeCallback;
}

interface ServerMessage {
  type: "event" | "error" | "subscribed" | "unsubscribed";
  event?: RealtimeEvent;
  id?: string;
  message?: string;
}

/**
 * Browser-native WebSocket based realtime client.
 *
 * Automatically reconnects with a small exponential back-off and resends
 * active subscriptions when the connection comes back.
 */
export class RealtimeClient {
  private baseUrl: string;
  private path: string;
  private enabled: boolean;
  private socket: WebSocket | null = null;
  private subscriptions = new Map<string, Subscription>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;
  private getToken: () => string | undefined;

  constructor(
    baseUrl: string,
    getToken: () => string | undefined,
    path = "/realtime",
    enabled = true
  ) {
    this.baseUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "");
    this.path = path.startsWith("/") ? path : `/${path}`;
    this.getToken = getToken;
    this.enabled = enabled;
  }

  /**
   * Subscribe to changes on a table.
   *
   * @example
   * ```ts
   * const unsub = db.subscribe("messages", (event) => {
   *   console.log(event.type, event.row);
   * });
   *
   * db.subscribe("messages", { where: { room_id: 1 } }, (event) => {
   *   // only events for room_id === 1
   * });
   * ```
   */
  subscribe<T = unknown>(
    table: string,
    callback: RealtimeCallback<T>
  ): () => void;
  subscribe<T = unknown>(
    table: string,
    options: SubscribeOptions,
    callback: RealtimeCallback<T>
  ): () => void;
  subscribe<T = unknown>(
    table: string,
    optionsOrCallback: SubscribeOptions | RealtimeCallback<T>,
    maybeCallback?: RealtimeCallback<T>
  ): () => void {
    let options: SubscribeOptions = {};
    let callback: RealtimeCallback<T>;

    if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback as RealtimeCallback<T>;
    } else {
      options = optionsOrCallback;
      callback = maybeCallback as RealtimeCallback<T>;
    }

    const id = generateId();
    const filters =
      options.filters ??
      (options.where
        ? Object.entries(options.where).map(([column, value]) => ({
            column,
            operator: "eq" as const,
            value,
          }))
        : []);

    const sub: Subscription = {
      id,
      table,
      filters,
      callback: callback as RealtimeCallback,
    };

    this.subscriptions.set(id, sub);
    if (this.enabled) {
      this.ensureConnected();
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(sub);
    }

    return () => {
      this.subscriptions.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "unsubscribe", id }));
      }
      if (this.subscriptions.size === 0) {
        // Drop the connection but leave the client reusable for future
        // subscriptions. `closed` is only set by an explicit `close()` call.
        if (this.socket) {
          this.socket.close();
          this.socket = null;
        }
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      }
    };
  }

  /**
   * Close the realtime connection. Active subscriptions are dropped.
   */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private ensureConnected(): void {
    if (!this.enabled) return;
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.closed) return;

    const url = this.buildUrl();
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      for (const sub of this.subscriptions.values()) {
        this.sendSubscribe(sub);
      }
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "event" && message.event) {
        for (const sub of this.subscriptions.values()) {
          if (sub.table !== message.event.table) continue;
          if (
            sub.filters.length > 0 &&
            !rowMatchesFilters(message.event.row, sub.filters)
          ) {
            continue;
          }
          sub.callback(message.event);
        }
      }
    });

    socket.addEventListener("close", () => {
      // Ignore close events from sockets we've already moved on from.
      if (this.socket === socket) {
        this.socket = null;
      }
      // Only reconnect if there are still active subscriptions. An
      // intentional unsubscribe may have closed the socket.
      if (this.subscriptions.size > 0) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // Errors are followed by close; reconnect is handled there.
    });
  }

  private buildUrl(): string {
    const token = this.getToken();
    if (!token) return `${this.baseUrl}${this.path}`;
    return `${this.baseUrl}${this.path}?token=${encodeURIComponent(token)}`;
  }

  private sendSubscribe(sub: Subscription): void {
    this.socket?.send(
      JSON.stringify({
        type: "subscribe",
        id: sub.id,
        table: sub.table,
        filters: sub.filters,
      })
    );
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscriptions.size > 0) {
        this.ensureConnected();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

function rowMatchesFilters(
  row: unknown,
  filters: RealtimeFilter[]
): boolean {
  if (typeof row !== "object" || row === null) return false;
  const record = row as Record<string, unknown>;

  for (const filter of filters) {
    const actual = record[filter.column];
    const expected = filter.value;

    switch (filter.operator) {
      case "eq":
        if (actual !== expected) return false;
        break;
      case "neq":
        if (actual === expected) return false;
        break;
      case "gt":
        if (compare(actual, expected) <= 0) return false;
        break;
      case "lt":
        if (compare(actual, expected) >= 0) return false;
        break;
      case "gte":
        if (compare(actual, expected) < 0) return false;
        break;
      case "lte":
        if (compare(actual, expected) > 0) return false;
        break;
      case "like": {
        if (typeof expected !== "string" || typeof actual !== "string") {
          return false;
        }
        const regex = new RegExp(
          "^" + expected.replace(/%/g, ".*").replace(/_/g, ".") + "$"
        );
        if (!regex.test(actual)) return false;
        break;
      }
      case "in":
        if (!Array.isArray(expected) || !expected.includes(actual)) {
          return false;
        }
        break;
      default:
        return false;
    }
  }

  return true;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  return String(a).localeCompare(String(b));
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
