import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Fixed-window length in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted within one window. */
  max: number;
  /**
   * Whether to trust `X-Forwarded-For` for client IP keying. Default `false`
   * so direct clients cannot spoof arbitrary IPs to bypass rate limits.
   */
  trustProxy?: boolean;
  /**
   * Maximum number of active buckets kept in memory. When exceeded, expired
   * entries are swept first, then the oldest entry is evicted. Default 10000.
   */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

interface Bucket {
  count: number;
  /** Epoch ms at which the current window elapses and the count resets. */
  resetAt: number;
}

/**
 * Resolve the client IP used to key rate-limit buckets.
 *
 * Order of preference:
 *   1. When `trustProxy` is true, the FIRST address in `X-Forwarded-For`.
 *   2. The TCP socket's remote address (present under @hono/node-server).
 *   3. The literal `"unknown"`, so requests with no resolvable address share a
 *      single bucket rather than bypassing the limit entirely.
 */
function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
  }
  // `c.req.raw` is the underlying Request. Under @hono/node-server it carries
  // the Node socket; under `app.request(...)` (tests) it has no socket.
  const raw = c.req.raw as Request & { socket?: { remoteAddress?: string } };
  const addr = raw.socket?.remoteAddress;
  if (addr) return addr;
  return "unknown";
}

/**
 * Build a fixed-window rate-limit middleware (dependency-free, in-process).
 *
 * Counts are kept in a `Map` keyed by `routePath|ip`, so each route counts
 * independently per client IP — exhausting the budget on `/api/auth/signin`
 * does NOT block `/api/auth/signup` for the same IP. A single middleware
 * instance can therefore be mounted on every abuse-sensitive route; route
 * isolation is automatic. `routePath` (the registered pattern, e.g.
 * `/_api/admin/users/:id/reset-password`) is used rather than the concrete
 * path so parametrized routes share one counter namespace per IP — an
 * attacker cannot dodge a password-reset cap by varying the id.
 *
 * When a client exceeds `max` within the current window the middleware
 * short-circuits with `429 Too Many Requests`, a `Retry-After` header (whole
 * seconds remaining in the window), and a JSON body
 * `{ error: "Too many requests" }`.
 *
 * A `setInterval` sweeps expired buckets so quiet keys do not accumulate
 * without bound. The timer is `unref`'d where supported so it never keeps a
 * process (or a test run) alive on its own.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const {
    windowMs,
    max,
    trustProxy = false,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = opts;
  const buckets = new Map<string, Bucket>();

  // Sweep roughly once per window (clamped to [1s, 60s]) to reclaim buckets
  // whose window has elapsed.
  const sweepMs = Math.min(Math.max(windowMs, 1000), 60_000);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, sweepMs);
  // `unref` is a Node-only concept; guard for runtimes without it.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return async (c, next) => {
    const ip = clientIp(c, trustProxy);
    const key = `${c.req.routePath}|${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxEntries) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= now) buckets.delete(k);
        }
        while (buckets.size >= maxEntries) {
          const oldest = buckets.keys().next().value;
          if (oldest === undefined) break;
          buckets.delete(oldest);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}
