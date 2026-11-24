import { Hono, type MiddlewareHandler } from "hono";
import { Auth, AuthError } from "./auth.js";
import { requireAuth, type AuthVariables } from "./middleware.js";

/**
 * Optional wiring for the auth router. `rateLimit` is the per-IP limiter built
 * by {@link createServer} from `security.rateLimits`; when supplied it is
 * mounted on the abuse-sensitive endpoints (signup, signin, refresh,
 * admin-requests, owner bootstrap) so a single client cannot hammer them.
 */
export interface AuthRouterOptions {
  rateLimit?: MiddlewareHandler;
}

/**
 * Hono router exposing the public `/api/auth/*` endpoints. The host server
 * mounts this at the root with `app.route("/", createAuthRouter(...))`,
 * so paths are absolute (`/api/auth/signup`, etc.).
 *
 * The router is intentionally thin — all business logic lives in `Auth`.
 * Its job is to translate HTTP <-> method calls and map `AuthError`
 * onto the right status code.
 */
export function createAuthRouter(
  auth: Auth,
  jwtSecret: string,
  options: AuthRouterOptions = {}
): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // Attach the rate limiter (when wired) to an abuse-sensitive POST path by
  // registering it as path-scoped middleware ahead of the route handler. This
  // runs before the handler for matching POSTs; a 429 short-circuits the
  // chain. OPTIONS preflights never reach it — the global CORS middleware
  // answers those before the router does.
  const guard = (path: string): void => {
    if (options.rateLimit) router.use(path, options.rateLimit);
  };

  router.get("/api/auth/admin-registration", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ data: { ownerExists: await auth.hasOwner() } });
  });

  // `admin-requests` is abuse-sensitive (unauthenticated write that persists a
  // row + may trigger side effects); rate-limit it when a limiter is wired.
  guard("/api/auth/admin-requests");
  router.post("/api/auth/admin-requests", async (c) => {
    try {
      const body = await readJson(c);
      const request = await auth.requestAdmin(body);
      return c.json({ data: request }, 202);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Owner bootstrap is a privileged signup (creates the first admin). It runs
  // password hashing, so rate-limit it like signup to bound CPU spend.
  guard("/api/auth/owner");
  router.post("/api/auth/owner", async (c) => {
    try {
      const body = await readJson(c);
      const session = await auth.signUp(body, true);
      return c.json({ data: session }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /api/auth/signup
  guard("/api/auth/signup");
  router.post("/api/auth/signup", async (c) => {
    try {
      const body = await readJson(c);
      const session = await auth.signUp(body);
      return c.json({ data: session }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /api/auth/signin
  guard("/api/auth/signin");
  router.post("/api/auth/signin", async (c) => {
    try {
      const body = await readJson(c);
      const session = await auth.signIn(body);
      return c.json({ data: session });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /api/auth/signout
  router.post(
    "/api/auth/signout",
    requireAuth(jwtSecret),
    async (c) => {
      try {
        const body = await readJson(c).catch(
          () => ({}) as Record<string, unknown>
        );
        const refreshToken =
          typeof body.refreshToken === "string"
            ? body.refreshToken
            : undefined;
        await auth.signOut(refreshToken);
        return c.json({ data: { success: true } });
      } catch (err) {
        return errorResponse(c, err);
      }
    }
  );

  // GET /api/auth/user
  router.get("/api/auth/user", requireAuth(jwtSecret), async (c) => {
    const { id } = c.get("user");
    const user = await auth.getUser(id);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json({ data: { user } });
  });

  // POST /api/auth/refresh
  guard("/api/auth/refresh");
  router.post("/api/auth/refresh", async (c) => {
    try {
      const body = await readJson(c);
      const refreshToken =
        typeof body.refreshToken === "string" ? body.refreshToken : "";
      const session = await auth.refresh(refreshToken);
      return c.json({ data: session });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return router;
}

// ─── helpers ───────────────────────────────────────────────────

async function readJson(
  c: { req: { json: () => Promise<unknown> } }
): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AuthError(400, "Request body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(400, "Invalid or missing JSON body");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorResponse(c: any, err: unknown) {
  if (err instanceof AuthError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("Auth error:", err);
  return c.json({ error: "Internal server error" }, 500);
}
