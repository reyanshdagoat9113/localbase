import type {
  PresenceEvent,
  RealtimeEvent,
  RealtimeFilter,
} from "@localbase/shared";

export type RealtimeCallback<T = unknown> = (event: RealtimeEvent<T>) => void;
export type PresenceCallback<T = unknown> = (event: PresenceEvent<T>) => void;

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

interface PresenceSubscription {
  channel: string;
  key: string;
  metadata?: unknown;
  callback: PresenceCallback;
}

interface ServerMessage {
  type: "event" | "presence" | "error" | "subscribed" | "unsubscribed" | "auth:ok" | "auth:error" | "resync:required";
  event?: RealtimeEvent | PresenceEvent;
  id?: string;
  message?: string;
  reason?: string;
  user?: { id: number; email: string };
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
  private presenceSubscriptions = new Map<string, PresenceSubscription>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;
  private lastEventId = 0;
  /**
   * Opaque, epoch-aware replay cursor echoed back on reconnect. Reset on
   * `resync-required` so the next reconnect replays from the current state.
   */
  private cursor: string | null = null;
  private getToken: () => string | undefined;
  /**
   * Per-connection auth state. The token is NEVER sent in the URL (it would
   * leak into proxy logs and browser history); instead the first frame after
   * open is `{ type: "auth", token }`. Subscriptions are only flushed once the
   * server acknowledges with `auth:ok`. When no token is available the client
   * skips the handshake (local-development servers with auth disabled).
   */
  private authed = false;
  /**
   * Set when the most recent socket was closed for an unrecoverable auth
   * reason (bad/expired-at-handshake token). Suppresses the reconnect loop so a
   * bad token can't drive a tight failure spin; the application must re-auth.
   */
  private authFailed = false;
  /**
   * Optional callback invoked when the server rejects authentication. Wired by
   * `createClient` so the application can react (e.g. redirect to sign-in).
   */
  onAuthError: ((message: string) => void) | null = null;
  /**
   * Optional callback invoked when the server signals `resync-required`
   * (server restarted, or the replay buffer evicted the client's position).
   * The application should refetch REST state; the SDK resets its cursor and
   * keeps delivering live events from the resync point onward.
   */
  onResync: ((reason: string) => void) | null = null;

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

    // If the socket is already privileged, register the subscription now;
    // otherwise it is buffered in `this.subscriptions` and flushed on auth:ok.
    if (this.socket?.readyState === WebSocket.OPEN && this.authed) {
      this.sendSubscribe(sub);
    }

    return () => {
      this.subscriptions.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN && this.authed) {
        this.socket.send(JSON.stringify({ type: "unsubscribe", id }));
      }
      this.closeIfIdle();
    };
  }

  presence<T = unknown>(
    channel: string,
    key: string,
    metadata: T,
    callback: PresenceCallback<T>
  ): { update(metadata: T): void; leave(): void } {
    const id = `${channel}:${key}`;
    this.presenceSubscriptions.set(id, {
      channel,
      key,
      metadata,
      callback: callback as PresenceCallback,
    });

    if (this.enabled) {
      this.ensureConnected();
    }

    if (this.socket?.readyState === WebSocket.OPEN && this.authed) {
      this.sendPresenceJoin(channel, key, metadata);
    }

    return {
      update: (nextMetadata: T) => {
        const sub = this.presenceSubscriptions.get(id);
        if (!sub) return;
        sub.metadata = nextMetadata;
        if (this.socket?.readyState === WebSocket.OPEN && this.authed) {
          this.sendPresenceJoin(channel, key, nextMetadata);
        }
      },
      leave: () => {
        this.presenceSubscriptions.delete(id);
        if (this.socket?.readyState === WebSocket.OPEN && this.authed) {
          this.socket.send(
            JSON.stringify({ type: "presence:leave", channel, key })
          );
        }
        this.closeIfIdle();
      },
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
    this.subscriptions.clear();
    this.presenceSubscriptions.clear();
  }

  private ensureConnected(): void {
    if (!this.enabled) return;
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.closed) return;

    const url = this.buildUrl();
    const socket = new WebSocket(url);
    this.socket = socket;
    this.authed = false;

    socket.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      const token = this.getToken();
      if (token) {
        // Authenticated handshake: send the token as the first frame. The
        // server keeps the connection unprivileged until it replies auth:ok,
        // at which point we flush the live subscriptions + presence.
        this.authed = false;
        socket.send(JSON.stringify({ type: "auth", token }));
      } else {
        // No token → assume an auth-disabled (local-dev) server and subscribe
        // immediately. If the server actually requires auth, it will close the
        // socket and the close handler surfaces the auth error.
        this.authed = true;
        this.flushPending();
      }
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (message.type === "auth:ok") {
        this.authed = true;
        this.flushPending();
        return;
      }
      if (message.type === "auth:error") {
        this.authed = false;
        this.authFailed = true;
        this.onAuthError?.(message.message ?? "Realtime authentication failed");
        return;
      }
      if (message.type === "resync:required") {
        // The client's stored position no longer maps to a contiguous
        // history. Forget it so the next reconnect starts fresh, and let the
        // application refetch canonical state.
        this.cursor = null;
        this.lastEventId = 0;
        this.onResync?.(message.reason ?? "resync");
        return;
      }

      if (message.type === "event" && message.event) {
        const realtimeEvent = message.event as RealtimeEvent;
        if (typeof realtimeEvent.id === "number") {
          this.lastEventId = Math.max(this.lastEventId, realtimeEvent.id);
        }
        if (typeof realtimeEvent.cursor === "string") {
          this.cursor = realtimeEvent.cursor;
        }
        for (const sub of this.subscriptions.values()) {
          if (sub.table !== realtimeEvent.table) continue;
          if (
            sub.filters.length > 0 &&
            !rowMatchesFilters(realtimeEvent.row, sub.filters)
          ) {
            continue;
          }
          sub.callback(realtimeEvent);
        }
      } else if (message.type === "presence" && message.event) {
        const presenceEvent = message.event as PresenceEvent;
        for (const sub of this.presenceSubscriptions.values()) {
          if (sub.channel === presenceEvent.channel) {
            sub.callback(presenceEvent);
          }
        }
      }
    });

    socket.addEventListener("close", (event) => {
      // Ignore close events from sockets we've already moved on from.
      if (this.socket === socket) {
        this.socket = null;
      }

      // A clean auth rejection: the server closed because the token was bad or
      // absent. Surface it once and stop retrying — a reconnect with the same
      // token would just fail again. 4001 = auth failed, 4002 = auth timeout.
      // (If the auth:error frame already surfaced this, `authFailed` guards the
      // duplicate.)
      if (event.code === 4001 || event.code === 4002) {
        if (!this.authFailed) {
          this.authFailed = true;
          this.onAuthError?.(
            event.code === 4002
              ? "Realtime authentication timed out"
              : "Realtime authentication failed"
          );
        }
        return;
      }

      // 4003 = token expired mid-session. Reconnect so getToken() can supply a
      // refreshed token. Any other close is treated as transient network churn.
      if (this.hasActiveWork()) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      // Errors are followed by close; reconnect is handled there.
    });
  }

  /** Send all live subscriptions + presence joins on a privileged socket. */
  private flushPending(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const sub of this.subscriptions.values()) {
      this.sendSubscribe(sub);
    }
    for (const sub of this.presenceSubscriptions.values()) {
      this.sendPresenceJoin(sub.channel, sub.key, sub.metadata);
    }
  }

  private buildUrl(): string {
    return `${this.baseUrl}${this.path}`;
  }

  private sendSubscribe(sub: Subscription): void {
    this.socket?.send(
      JSON.stringify({
        type: "subscribe",
        id: sub.id,
        table: sub.table,
        filters: sub.filters,
        // Send the opaque cursor (epoch-aware) when available; fall back to the
        // numeric lastEventId so older servers still replay correctly.
        cursor: this.cursor ?? undefined,
        lastEventId: this.cursor ? undefined : this.lastEventId,
      })
    );
  }

  private sendPresenceJoin(
    channel: string,
    key: string,
    metadata: unknown
  ): void {
    this.socket?.send(
      JSON.stringify({
        type: "presence:join",
        channel,
        key,
        metadata,
      })
    );
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.hasActiveWork()) {
        this.ensureConnected();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private closeIfIdle(): void {
    if (this.hasActiveWork()) return;

    // Drop the connection but leave the client reusable for future work.
    // `closed` is only set by an explicit `close()` call.
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private hasActiveWork(): boolean {
    return this.subscriptions.size > 0 || this.presenceSubscriptions.size > 0;
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
