import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessToken } from "./tokens.js";
import type { Database } from "../db.js";

/** Public user object attached to the Hono context after a successful auth. */
export interface AuthenticatedUser {
  id: number;
  email: string;
  /** Role snapshot from the access token (`"user"` | `"admin"` | `"owner"`). */
  role: string;
}

/** Augment Hono's context with the user key. */
export type AuthVariables = {
  user: AuthenticatedUser;
};

/**
 * The admin principal attached to the context after a successful
 * `requireAdmin` check. Unlike {@link AuthenticatedUser}, this carries the
 * current `role` re-read from the database at request time (not the JWT
 * snapshot), so handlers always see the live role.
 */
export interface AdminAuthenticatedUser {
  id: number;
  email: string;
  role: string;
}

/** Augment Hono's context with the admin principal. */
export type AdminVariables = {
  adminUser: AdminAuthenticatedUser;
};

/**
 * Hono middleware factory. Verifies the `Authorization: Bearer <jwt>` header
 * against `secret` and, on success, attaches the user to the context as
 * `c.get("user")`.
 *
 * On failure responds with 401 and `{ error: "..." }`. Exposed as a factory
 * so the same secret can be re-used across many route registrations.
 *
 * Usage:
 *   const app = createServer(db, schema, authConfig);
 *   app.get("/api/protected", requireAuth(authConfig.jwtSecret!), handler);
 */
export function requireAuth(secret: string): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return c.json(
        { error: "Authorization header must be 'Bearer <token>'" },
        401
      );
    }

    try {
      const claims = await verifyAccessToken(token, secret);
      const id = Number(claims.sub);
      if (!Number.isFinite(id)) {
        return c.json({ error: "Invalid token subject" }, 401);
      }
      c.set("user", { id, email: claims.email, role: claims.role });
      await next();
    } catch (err) {
      if (err instanceof Error && err.name === "JWTExpired") {
        return c.json({ error: "Token expired" }, 401);
      }
      return c.json({ error: "Invalid token" }, 401);
    }
  };
}

/**
 * Verify the `Authorization: Bearer <jwt>` header and return the authenticated
 * user, or `null` on any failure (missing/malformed/invalid/expired token).
 *
 * Unlike {@link requireAuth}, this is a plain function (not middleware) and
 * produces no HTTP response — callers decide how to handle `null`. RLS uses it
 * inside the `/api/:table` handlers to authenticate lazily, only for tables that
 * have a policy, so tables without a policy stay open to anonymous requests.
 */
export async function authenticate(
  c: Context,
  secret: string
): Promise<AuthenticatedUser | null> {
  const header = c.req.header("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;

  try {
    const claims = await verifyAccessToken(token, secret);
    const id = Number(claims.sub);
    if (!Number.isFinite(id)) return null;
    return { id, email: claims.email, role: claims.role };
  } catch {
    return null;
  }
}

/**
 * Hono middleware factory that gates a route behind admin authorization.
 *
 * This does TWO checks, not one:
 *
 *   1. The access token is valid (signature + expiry). Same as `requireAuth`.
 *   2. The user identified by the token currently has an administrative role
 *      `_users`, re-read from the database on every request.
 *
 * The second check is the important one. The JWT carries a `role` claim, but
 * that's only a snapshot from issue time. If an admin is demoted (or their
 * account deleted), their existing access token would still claim
 * `role: "admin"` until it expires (up to `accessTokenExpiry`, default 1h).
 * Re-reading the live role closes that window: demotion takes effect on the
 * very next admin request, immediately.
 *
 * The trade-off is one indexed `_users` lookup per admin request. For a
 * management/admin surface (low QPS, single operator) that cost is negligible
 * and the security property is worth it. If this ever moves to a hot path,
 * a short-TTL in-process role cache would preserve the property.
 *
 * Responses:
 *   401 — missing/malformed/invalid/expired token, or the user no longer
 *         exists (deleted). All return a generic message so an attacker
 *         can't distinguish "bad token" from "deleted user".
 *   403 — valid token, but the user is not currently an admin.
 *
 * Usage:
 *   router.use("/_api/admin/*", requireAdmin(secret, db));
 */
export function requireAdmin(
  secret: string,
  db: Database
): MiddlewareHandler<{ Variables: AdminVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return c.json(
        { error: "Authorization header must be 'Bearer <token>'" },
        401
      );
    }

    let claims;
    try {
      claims = await verifyAccessToken(token, secret);
    } catch (err) {
      if (err instanceof Error && err.name === "JWTExpired") {
        return c.json({ error: "Token expired" }, 401);
      }
      return c.json({ error: "Invalid token" }, 401);
    }

    const id = Number(claims.sub);
    if (!Number.isFinite(id)) {
      return c.json({ error: "Invalid token" }, 401);
    }

    // Re-read the live role. A deleted user has no row → treat as invalid
    // (generic 401) so the existence of an account isn't leaked.
    const row = (await db.selectById("_users", id)) as
      | { role?: string; email?: string }
      | undefined;
    if (!row) {
      return c.json({ error: "Invalid token" }, 401);
    }
    if (row.role !== "admin" && row.role !== "owner") {
      return c.json({ error: "Admin access required" }, 403);
    }

    c.set("adminUser", {
      id,
      email: row.email ?? claims.email,
      role: row.role,
    });
    await next();
  };
}
