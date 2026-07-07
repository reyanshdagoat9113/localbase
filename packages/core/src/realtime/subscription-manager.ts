import type { WebSocket } from "ws";
import type {
  PresenceEvent,
  PresenceState,
  RealtimeEvent,
  RealtimeFilter,
} from "@localbase/shared";
import type { Database } from "../db.js";
import type { ResolvedPolicy } from "../rls.js";
import { liveAdminRole } from "../rls.js";
import { rowMatchesFilters } from "./filter.js";

export interface ClientSubscription {
  table: string;
  filters: RealtimeFilter[];
  /**
   * Server-enforced owner scope. Only present when the table has a policy AND
   * the connection is authenticated. The client's `filters` are AND-ed AFTER
   * this gate, so a forged filter can never broaden visibility beyond the
   * caller's own rows.
   */
  scope?: {
    ownerColumn: string;
    /** Authenticated user id — rows must satisfy `row[ownerColumn] === userId`. */
    userId: number;
    /**
     * True when the policy allows `adminBypass` and the user was an admin at
     * subscribe time. Re-checked live (TTL-cached) on every matching event so a
     * demotion takes effect without waiting for the access token to expire.
     */
    bypass: boolean;
  };
}

interface RoleCache {
  admin: boolean;
  at: number;
}

interface ClientState {
  socket: WebSocket;
  /** Authenticated principal, or `null` when auth is disabled (local dev). */
  user: { id: number; email: string; role: string } | null;
  subscriptions: Map<string, ClientSubscription>;
  presence: Map<string, PresenceState>;
  roleCache: RoleCache | null;
}

/** Outcome of a subscribe attempt, surfaced to the caller for the wire ack. */
export type SubscribeOutcome =
  | { ok: true }
  | { ok: false; reason: "auth_required" | "too_many_subscriptions" | "too_many_filters" };

/** Outcome of a presence join, surfaced for the wire ack/error. */
export type PresenceOutcome =
  | { ok: true }
  | { ok: false; reason: "too_many_channels" };

/** Resolved realtime limits (defaults applied). */
export interface ResolvedRealtimeLimits {
  maxSubscriptionsPerSocket: number;
  maxPresenceChannelsPerSocket: number;
  maxBufferedBytes: number;
}

const DEFAULT_LIMITS: ResolvedRealtimeLimits = {
  maxSubscriptionsPerSocket: 100,
  maxPresenceChannelsPerSocket: 32,
  maxBufferedBytes: 1024 * 1024,
};

/**
 * Tracks active WebSocket subscriptions and routes realtime events to the
 * clients whose filters match the changed row.
 *
 * When constructed with a `database` + `policyMap`, subscriptions to policy'd
 * tables are owner-scoped to the authenticated user — mirroring the REST
 * `resolveOwnerScope` path so the two surfaces cannot drift. Without them the
 * manager degrades to the original connection-agnostic router used for
 * unauthenticated local development.
 */
export class SubscriptionManager {
  private clients = new Map<WebSocket, ClientState>();
  private database: Database | undefined;
  private policyMap: Map<string, ResolvedPolicy> | undefined;
  private roleTtlMs: number;
  private limits: ResolvedRealtimeLimits;

  constructor(options?: {
    database?: Database;
    policyMap?: Map<string, ResolvedPolicy>;
    /** Max staleness for the per-connection live-admin-role cache. */
    roleTtlMs?: number;
    limits?: Partial<ResolvedRealtimeLimits>;
  }) {
    this.database = options?.database;
    this.policyMap = options?.policyMap;
    this.roleTtlMs = options?.roleTtlMs ?? 2000;
    this.limits = { ...DEFAULT_LIMITS, ...options?.limits };
  }

  addClient(
    socket: WebSocket,
    user: { id: number; email: string; role: string } | null = null
  ): void {
    this.clients.set(socket, {
      socket,
      user,
      subscriptions: new Map(),
      presence: new Map(),
      roleCache: null,
    });
  }

  /** Update the authenticated principal after a successful handshake. */
  setUser(
    socket: WebSocket,
    user: { id: number; email: string; role: string }
  ): void {
    const client = this.clients.get(socket);
    if (!client) return;
    client.user = user;
    client.roleCache = null;
  }

  /** Read the authenticated principal for a connection (null if anonymous). */
  getUser(socket: WebSocket): { id: number; email: string; role: string } | null {
    return this.clients.get(socket)?.user ?? null;
  }

  removeClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  /**
   * Register a subscription. When the table is owner-protected, the caller's
   * scope is resolved here (live admin role re-read with a short TTL) and
   * frozen onto the subscription so the per-event match is a pure function
   * of the row + the (server-supplied) scope.
   */
  subscribe(
    socket: WebSocket,
    subscriptionId: string,
    table: string,
    filters: RealtimeFilter[]
  ): SubscribeOutcome {
    const client = this.clients.get(socket);
    if (!client) return { ok: false, reason: "auth_required" };

    if (client.subscriptions.size >= this.limits.maxSubscriptionsPerSocket) {
      return { ok: false, reason: "too_many_subscriptions" };
    }

    const scope = this.resolveScope(client, table);
    if (scope === "denied") return { ok: false, reason: "auth_required" };

    client.subscriptions.set(subscriptionId, { table, filters, scope });
    return { ok: true };
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
        if (this.matchesSubscription(event, sub, client)) {
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
        if (this.matchesSubscription(event, sub, client)) {
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
    metadata: unknown
  ): PresenceOutcome {
    const client = this.clients.get(socket);
    if (!client) return { ok: false, reason: "too_many_channels" };

    const isNewChannel = ![...client.presence.values()].some(
      (state) => state.channel === channel
    );
    if (
      isNewChannel &&
      this.distinctPresenceChannels(client) >= this.limits.maxPresenceChannelsPerSocket
    ) {
      return { ok: false, reason: "too_many_channels" };
    }

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
    return { ok: true };
  }

  private distinctPresenceChannels(client: ClientState): number {
    const channels = new Set<string>();
    for (const state of client.presence.values()) {
      channels.add(state.channel);
    }
    return channels.size;
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

  // ─── Authorization ──────────────────────────────────────────────

  /**
   * Resolve the effective owner scope for `table` under the current principal.
   * Mirrors the REST `resolveOwnerScope` decision:
   *   - no policy on the table → unscoped (`undefined`) — public table;
   *   - policy but no authenticated user → `denied`;
   *   - policy + `adminBypass` + live admin → bypass scope (all rows);
   *   - otherwise → owner-scoped to `user.id`.
   */
  private resolveScope(
    client: ClientState,
    table: string
  ): { ownerColumn: string; userId: number; bypass: boolean } | "denied" | undefined {
    if (!this.policyMap || !this.database) return undefined;
    const policy = this.policyMap.get(table);
    if (!policy) return undefined;
    if (!client.user) return "denied";

    const bypass = policy.adminBypass && this.isLiveAdmin(client);
    return {
      ownerColumn: policy.ownerColumn,
      userId: client.user.id,
      bypass,
    };
  }

  /**
   * TTL-cached live admin check. Caching bounds the per-event cost (one indexed
   * `_users` lookup per connection per TTL window) while keeping demotion
   * latency well under the access-token lifetime — satisfying "demoted admins
   * lose bypass privileges without waiting for JWT expiry."
   */
  private isLiveAdmin(client: ClientState): boolean {
    if (!client.user) return false;
    const now = Date.now();
    if (client.roleCache && now - client.roleCache.at < this.roleTtlMs) {
      return client.roleCache.admin;
    }
    const admin = liveAdminRole(this.database!, client.user.id);
    client.roleCache = { admin, at: now };
    return admin;
  }

  private matchesSubscription(
    event: RealtimeEvent,
    subscription: ClientSubscription,
    client: ClientState
  ): boolean {
    const row = event.row as Record<string, unknown> | undefined;
    if (subscription.table !== event.table) return false;
    if (row === undefined) return false;

    // Server-enforced owner gate. Applied BEFORE any client filter so a forged
    // filter can never widen visibility. Bypass subscriptions re-check the live
    // admin role on each event; a demoted admin immediately falls back to
    // seeing only their own rows (and nothing if they never owned any).
    if (subscription.scope) {
      const { ownerColumn, userId, bypass } = subscription.scope;
      if (bypass && this.isLiveAdmin(client)) {
        // admin sees all rows on this table
      } else {
        if (row[ownerColumn] !== userId) return false;
      }
    }

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
    if (socket.readyState !== 1 /* OPEN */) return;
    // Backpressure: if the consumer is not draining, drop the connection
    // rather than let buffered writes grow unbounded and exhaust memory. A
    // single slow subscriber must never stall or OOM the server.
    if (socket.bufferedAmount >= this.limits.maxBufferedBytes) {
      socket.close(4009, "backpressure");
      return;
    }
    socket.send(JSON.stringify(payload));
  }
}

function presenceId(channel: string, key: string): string {
  return `${channel}:${key}`;
}
