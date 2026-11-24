import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import type { Database } from "../db.js";
import type {
  RealtimeConfig,
  RealtimeEvent,
  RealtimeFilter,
  RealtimeLimits,
} from "@localbase/shared";
import type { ResolvedPolicy } from "../rls.js";
import { verifyAccessToken, type AccessTokenClaims } from "../auth/index.js";
import {
  SubscriptionManager,
  type ClientSubscription,
  type ResolvedRealtimeLimits,
} from "./subscription-manager.js";
import { isSystemTable } from "../admin/system-tables.js";

export interface RealtimeServerOptions {
  /** HTTP/HTTPS server to attach the WebSocket server to. */
  server: HttpServer | HttpsServer;
  /** LocalBase database instance to listen for changes on. */
  database: Database;
  /** Realtime configuration. */
  config?: RealtimeConfig;
  /**
   * JWT secret used to verify access tokens at the WebSocket handshake.
   *
   * When set, every socket must send a valid `auth` message within
   * {@link RealtimeConfig.authTimeoutMs} or be closed; no other messages are
   * accepted until authentication succeeds. When omitted, sockets are
   * anonymous — the documented local-development mode. Combining anonymous
   * realtime with owner-protected policies is rejected at startup (see the
   * guard in {@link createRealtimeServer}).
   */
  authSecret?: string;
  /**
   * Resolved RLS policies. When present (and `authSecret` is set),
   * subscriptions to these tables are owner-scoped to the authenticated user
   * and admin-bypassed when the policy allows it and the live role is admin.
   */
  policies?: Map<string, ResolvedPolicy>;
  /**
   * Max staleness (ms) for the per-connection live-admin-role cache used by
   * `adminBypass` subscriptions. Lower values make demotion take effect faster
   * at the cost of more `_users` lookups. Default: 2000.
   */
  roleTtlMs?: number;
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
  cursor?: string;
}

interface UnsubscribeMessage {
  type: "unsubscribe";
  id: string;
}

interface AuthMessage {
  type: "auth";
  token: string;
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

type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | AuthMessage
  | PresenceJoinMessage
  | PresenceLeaveMessage;

/** Per-connection realtime state. */
interface ConnectionState {
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** Inbound message-rate token bucket. */
  rateTokens: number;
  rateLast: number;
  /** Last inbound activity (message or pong) for idle cleanup. */
  lastSeen: number;
  pingTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const AUTH_TIMEOUT_CLOSE_CODE = 4002;
const AUTH_FAILED_CLOSE_CODE = 4001;
const TOKEN_EXPIRED_CLOSE_CODE = 4003;
const RATE_LIMIT_CLOSE_CODE = 4008;

const DEFAULT_LIMITS: Required<RealtimeLimits> = {
  maxSubscriptionsPerSocket: 100,
  maxFiltersPerSubscription: 16,
  maxPresenceChannelsPerSocket: 32,
  maxPresenceKeyLength: 128,
  maxPresenceMetadataBytes: 4096,
  maxMessagesPerSecond: 50,
  maxBufferedBytes: 1024 * 1024,
  maxPayloadBytes: 1024 * 1024,
};

/**
 * Monotonic per-process epoch. Each enabled realtime server bumps it, so a
 * client holding a cursor from a previous server instance (or a previous
 * epoch within the process) gets a `resync-required` rather than a silently
 * incomplete replay after a restart.
 */
let realtimeEpochCounter = 0;

/**
 * Attach a WebSocket realtime server to an existing HTTP server.
 *
 * Auth model:
 *   - When `authSecret` is provided, the socket starts unauthenticated. The
 *     first message MUST be `{ type: "auth", token }`; it is verified against
 *     the secret and, on success, the connection becomes authenticated for its
 *     lifetime. Tokens are never accepted via the URL (they would leak into
 *     proxy logs and browser history). A bounded timeout closes sockets that
 *     never authenticate.
 *   - When `authSecret` is omitted, the socket is anonymous and every table is
 *     public (the local-development default). Owner-protected policies may not
 *     be combined with this mode — see the startup guard below.
 *
 * Replay model:
 *   Events carry an opaque, epoch-aware `cursor`. On reconnect a client echoes
 *   the last cursor; if the server epoch changed (restart) or the cursor fell
 *   behind the bounded buffer's low-water mark, the server replies
 *   `resync-required` instead of returning a partial history.
 */
export function createRealtimeServer(
  options: RealtimeServerOptions
): RealtimeServer {
  const { server, database, config } = options;
  const authSecret = options.authSecret;
  const policyMap = options.policies;
  const limits: Required<RealtimeLimits> = { ...DEFAULT_LIMITS, ...config?.limits };

  if (config?.enabled === false) {
    const wss = new WebSocketServer({ noServer: true });
    return {
      wss,
      subscriptions: new SubscriptionManager({ database, policyMap, limits }),
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

  // Startup guard (contract item 6): silently running an unprotected socket
  // while owner-protected policies are declared is unacceptable. If policies
  // exist the realtime server MUST be authenticated; otherwise refuse to start.
  if (policyMap && policyMap.size > 0 && !authSecret) {
    throw new Error(
      "[localbase] Realtime is enabled with owner-protected policies but no " +
        "auth secret. Either enable auth (so the WebSocket handshake " +
        "authenticates subscriptions) or disable realtime. Refusing to start " +
        "an unprotected socket."
    );
  }

  const path = config?.path ?? "/realtime";
  const eventLogSize = config?.eventLogSize ?? 1000;
  const presenceEnabled = config?.presence ?? true;
  const authTimeoutMs = config?.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const pingIntervalMs = config?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const requireAuth = authSecret !== undefined;
  const epoch = ++realtimeEpochCounter;

  const managerLimits: Partial<ResolvedRealtimeLimits> = {
    maxSubscriptionsPerSocket: limits.maxSubscriptionsPerSocket,
    maxPresenceChannelsPerSocket: limits.maxPresenceChannelsPerSocket,
    maxBufferedBytes: limits.maxBufferedBytes,
  };

  const wss = new WebSocketServer({ server, path, maxPayload: limits.maxPayloadBytes });
  const subscriptions = new SubscriptionManager({
    database,
    policyMap,
    roleTtlMs: options.roleTtlMs,
    limits: managerLimits,
  });
  const eventLog: RealtimeEvent[] = [];
  const states = new WeakMap<WebSocket, ConnectionState>();
  let nextEventId = 1;

  function onDatabaseChange(event: RealtimeEvent) {
    const id = nextEventId++;
    const loggedEvent: RealtimeEvent = {
      ...event,
      id,
      timestamp: new Date().toISOString(),
      cursor: encodeCursor(epoch, id),
    };
    eventLog.push(loggedEvent);
    if (eventLog.length > eventLogSize) {
      eventLog.splice(0, eventLog.length - eventLogSize);
    }
    void subscriptions.broadcast(loggedEvent);
  }

  database.on("change", onDatabaseChange);

  wss.on("connection", (socket: WebSocket) => {
    subscriptions.addClient(socket, null);
    const now = Date.now();
    const state: ConnectionState = {
      authenticated: !requireAuth,
      authTimer: null,
      expiryTimer: null,
      rateTokens: limits.maxMessagesPerSecond,
      rateLast: now,
      lastSeen: now,
      pingTimer: null,
    };
    states.set(socket, state);

    if (requireAuth && !state.authenticated) {
      state.authTimer = setTimeout(() => {
        if (!states.get(socket)?.authenticated) {
          safeSend(socket, {
            type: "auth:error",
            message: "Authentication timeout",
          });
          socket.close(AUTH_TIMEOUT_CLOSE_CODE, "auth timeout");
        }
      }, authTimeoutMs);
    }

    armPing(socket, state);

    socket.on("message", (raw) => {
      state.lastSeen = Date.now();
      if (!consumeToken(state)) {
        socket.close(RATE_LIMIT_CLOSE_CODE, "rate limit");
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        safeSend(socket, { type: "error", message: "Invalid JSON" });
        return;
      }

      // While pending authentication, the ONLY accepted message is `auth`.
      if (requireAuth && !state.authenticated) {
        handleMessagePending(socket, state, message);
        return;
      }

      if (!isClientMessage(message)) {
        safeSend(socket, { type: "error", message: "Unknown message type" });
        return;
      }

      handleMessage(socket, message);
    });

    socket.on("pong", () => {
      const s = states.get(socket);
      if (s) s.lastSeen = Date.now();
    });

    socket.on("close", () => cleanup(socket, state));
    socket.on("error", () => cleanup(socket, state));
  });

  // ─── Rate limiting (token bucket per connection) ───────────────

  function consumeToken(state: ConnectionState): boolean {
    const now = Date.now();
    const elapsed = (now - state.rateLast) / 1000;
    state.rateTokens = Math.min(
      limits.maxMessagesPerSecond,
      state.rateTokens + elapsed * limits.maxMessagesPerSecond
    );
    state.rateLast = now;
    if (state.rateTokens < 1) return false;
    state.rateTokens -= 1;
    return true;
  }

  // ─── Idle/liveness cleanup ─────────────────────────────────────

  function armPing(socket: WebSocket, state: ConnectionState): void {
    if (pingIntervalMs <= 0) return;
    const idleLimit = pingIntervalMs * 2.5;
    state.pingTimer = setInterval(() => {
      if (socket.readyState !== 1 /* OPEN */) return;
      if (Date.now() - state.lastSeen > idleLimit) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, pingIntervalMs);
  }

  // ─── Pending (pre-auth) message handling ──────────────────────

  function handleMessagePending(
    socket: WebSocket,
    state: ConnectionState,
    message: unknown
  ): void {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: string }).type === "auth"
    ) {
      void authenticateConnection(socket, state, message as AuthMessage);
      return;
    }
    // Any non-auth message before authentication is rejected. Close rather
    // than just nack so a misbehaving client can't probe the surface.
    safeSend(socket, {
      type: "auth:error",
      message: "Authentication required",
    });
    socket.close(AUTH_FAILED_CLOSE_CODE, "auth required");
  }

  async function authenticateConnection(
    socket: WebSocket,
    state: ConnectionState,
    message: AuthMessage
  ): Promise<void> {
    if (typeof message.token !== "string") {
      return denyAuth(socket, "Missing token");
    }
    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(message.token, authSecret!);
    } catch {
      return denyAuth(socket, "Invalid or expired token");
    }
    const id = Number(claims.sub);
    if (!Number.isFinite(id)) {
      return denyAuth(socket, "Invalid token subject");
    }

    // Success: clear the auth timer and promote the connection.
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    state.authenticated = true;
    subscriptions.setUser(socket, {
      id,
      email: claims.email,
      role: claims.role,
    });

    // Schedule a de-auth at the token's expiry. The server cannot detect
    // in-flight revocation (access tokens are stateless), so closing at `exp`
    // bounds a stolen token's realtime lifetime to its natural expiry; the
    // client reconnects with a refreshed token.
    scheduleExpiry(socket, state, claims);

    safeSend(socket, {
      type: "auth:ok",
      user: { id, email: claims.email },
    });
  }

  function denyAuth(socket: WebSocket, message: string): void {
    safeSend(socket, { type: "auth:error", message });
    socket.close(AUTH_FAILED_CLOSE_CODE, "auth failed");
  }

  function scheduleExpiry(
    socket: WebSocket,
    state: ConnectionState,
    claims: AccessTokenClaims
  ): void {
    const ms = Math.floor(claims.exp * 1000 - Date.now());
    if (!Number.isFinite(ms) || ms <= 0) return;
    // Cap the timer so an absurdly long-lived token still gets a periodic
    // re-validation window rather than holding a socket open for days.
    const delay = Math.min(ms, 60 * 60 * 1000);
    state.expiryTimer = setTimeout(() => {
      safeSend(socket, {
        type: "auth:error",
        message: "Token expired",
      });
      socket.close(TOKEN_EXPIRED_CLOSE_CODE, "token expired");
    }, delay);
  }

  // ─── Authenticated message handling ───────────────────────────

  function handleMessage(socket: WebSocket, message: ClientMessage): void {
    if (message.type === "subscribe") {
      void handleSubscribe(socket, message);
    } else if (message.type === "unsubscribe") {
      subscriptions.unsubscribe(socket, message.id);
      safeSend(socket, { type: "unsubscribed", id: message.id });
    } else if (message.type === "presence:join") {
      handlePresenceJoin(socket, message);
    } else if (message.type === "presence:leave") {
      subscriptions.leavePresence(socket, message.channel, message.key);
    }
  }

  async function handleSubscribe(
    socket: WebSocket,
    message: SubscribeMessage
  ): Promise<void> {
    if (isSystemTable(message.table)) {
      safeSend(socket, {
        type: "error",
        message: "System tables are not subscribable",
      });
      return;
    }

    const id = message.id ?? generateId();
    const filters = normalizeFilters(message.filters);
    if (filters.length > limits.maxFiltersPerSubscription) {
      safeSend(socket, {
        type: "error",
        message: `Too many filters (max ${limits.maxFiltersPerSubscription})`,
      });
      return;
    }

    const outcome = await subscriptions.subscribe(
      socket,
      id,
      message.table,
      filters
    );
    if (!outcome.ok) {
      safeSend(socket, {
        type: "error",
        message:
          outcome.reason === "auth_required"
            ? "Authentication required"
            : "Subscription limit reached",
      });
      return;
    }

    safeSend(socket, { type: "subscribed", id, table: message.table });
    await requestReplay(socket, message);
  }

  async function requestReplay(
    socket: WebSocket,
    message: SubscribeMessage
  ): Promise<void> {
    // Resolve the requested (epoch, seq). Prefer the opaque cursor; fall back
    // to the legacy numeric lastEventId (treated as the current epoch).
    let reqEpoch = epoch;
    let reqSeq: number | null = null;
    if (typeof message.cursor === "string") {
      const decoded = decodeCursor(message.cursor);
      if (decoded) {
        reqEpoch = decoded.epoch;
        reqSeq = decoded.seq;
      } else {
        safeSend(socket, { type: "resync:required", reason: "invalid_cursor" });
        return;
      }
    } else if (typeof message.lastEventId === "number") {
      reqSeq = message.lastEventId;
    }

    if (reqSeq === null) return;

    if (reqEpoch !== epoch) {
      safeSend(socket, { type: "resync:required", reason: "server_restarted" });
      return;
    }

    // Eviction: if the next event the client needs is older than the buffer's
    // low-water mark, history is incomplete → resync rather than return a gap.
    if (eventLog.length > 0) {
      const oldest = eventLog[0].id ?? 0;
      if (reqSeq + 1 < oldest) {
        safeSend(socket, { type: "resync:required", reason: "buffer_evicted" });
        return;
      }
    }

    await subscriptions.replay(
      socket,
      eventLog.filter((event) => (event.id ?? 0) > reqSeq!)
    );
  }

  function handlePresenceJoin(
    socket: WebSocket,
    message: PresenceJoinMessage
  ): void {
    if (!presenceEnabled) {
      safeSend(socket, { type: "error", message: "Presence disabled" });
      return;
    }

    // Bound channel/key lengths and metadata size before accepting the join.
    if (
      message.channel.length > limits.maxPresenceKeyLength ||
      message.key.length > limits.maxPresenceKeyLength
    ) {
      safeSend(socket, {
        type: "error",
        message: `Presence channel/key too long (max ${limits.maxPresenceKeyLength})`,
      });
      return;
    }
    const metadataBytes = byteLength(JSON.stringify(message.metadata ?? null));
    if (metadataBytes > limits.maxPresenceMetadataBytes) {
      safeSend(socket, {
        type: "error",
        message: `Presence metadata too large (max ${limits.maxPresenceMetadataBytes} bytes)`,
      });
      return;
    }

    // When auth is on, presence identities are derived from the authenticated
    // principal so a client cannot impersonate another user. The client-supplied
    // key is replaced with the verified user id; metadata stays client-owned.
    let key = message.key;
    if (requireAuth) {
      const user = subscriptions.getUser(socket);
      if (user) key = String(user.id);
    }

    const outcome = subscriptions.joinPresence(
      socket,
      message.channel,
      key,
      message.metadata
    );
    if (!outcome.ok) {
      safeSend(socket, {
        type: "error",
        message: "Presence channel limit reached",
      });
    }
  }

  function cleanup(socket: WebSocket, state: ConnectionState): void {
    if (state.authTimer) {
      clearTimeout(state.authTimer);
      state.authTimer = null;
    }
    if (state.expiryTimer) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    subscriptions.leaveAllPresence(socket);
    subscriptions.unsubscribeAll(socket);
    subscriptions.removeClient(socket);
  }

  return {
    wss,
    subscriptions,
    close(): Promise<void> {
      database.off("change", onDatabaseChange);
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

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === 1 /* OPEN */) {
    socket.send(JSON.stringify(payload));
  }
}

function isClientMessage(msg: unknown): msg is ClientMessage {
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

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function encodeCursor(epoch: number, seq: number): string {
  return Buffer.from(`${epoch}.${seq}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { epoch: number; seq: number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 2) return null;
    const epoch = Number(parts[0]);
    const seq = Number(parts[1]);
    if (!Number.isFinite(epoch) || !Number.isFinite(seq)) return null;
    return { epoch, seq };
  } catch {
    return null;
  }
}

// Re-exported so callers that import from this module keep the type available.
export type { ClientSubscription };
