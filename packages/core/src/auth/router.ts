import { Hono } from "hono";
import { Auth, AuthError } from "./auth.js";
import { requireAuth, type AuthVariables } from "./middleware.js";

/**
 * Hono router exposing the 5 `/api/auth/*` endpoints. The host server
 * mounts this at the root with `app.route("/", createAuthRouter(...))`,
 * so paths are absolute (`/api/auth/signup`, etc.).
 *
 * The router is intentionally thin — all business logic lives in `Auth`.
 * Its job is to translate HTTP <-> method calls and map `AuthError`
 * onto the right status code.
 */
export function createAuthRouter(
  auth: Auth,
  jwtSecret: string
): Hono<{ Variables: AuthVariables }> {
  const router = new Hono<{ Variables: AuthVariables }>();

  // POST /api/auth/signup
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
  router.get("/api/auth/user", requireAuth(jwtSecret), (c) => {
    const { id } = c.get("user");
    const user = auth.getUser(id);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json({ data: { user } });
  });

  // POST /api/auth/refresh
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
