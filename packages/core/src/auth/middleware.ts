import type { Context, MiddlewareHandler } from "hono";
import { verifyAccessToken } from "./tokens.js";

/** Public user object attached to the Hono context after a successful auth. */
export interface AuthenticatedUser {
  id: number;
  email: string;
}

/** Augment Hono's context with the user key. */
export type AuthVariables = {
  user: AuthenticatedUser;
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
      c.set("user", { id, email: claims.email });
      await next();
    } catch (err) {
      if (err instanceof Error && err.name === "JWTExpired") {
        return c.json({ error: "Token expired" }, 401);
      }
      return c.json({ error: "Invalid token" }, 401);
    }
  };
}
