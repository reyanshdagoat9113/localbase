import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  APP_ORIGIN,
  AUTH_FILE,
  BASE_URL,
  SESSION_KEY,
  USER_EMAIL,
} from "./lib/env.js";
import { seedAccounts } from "./lib/seed.js";
import { bearer, signIn, type AuthSession } from "./lib/helpers.js";

/**
 * Runs once before the suite, against the already-started dev server.
 *
 * 1. Verify the *real* admin SPA bundle is being served (not the M1
 *    placeholder). Without it the UI tests cannot run.
 * 2. Idempotently seed the canonical admin + plain user via the CLI.
 * 3. Sign in as the admin and persist the session to a storageState file so
 *    the browser tests can skip the login screen.
 */
export default async function globalSetup(): Promise<void> {
  await assertAdminBundleServed();

  seedAccounts();

  const { request } = await import("@playwright/test");
  const ctx = await request.newContext();
  try {
    const session = await signIn(ctx, BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    if (session.user.role !== "admin") {
      throw new Error(
        `Seed account ${ADMIN_EMAIL} is not an admin (role=${session.user.role}). ` +
          "The global setup promotes it; check `localbase admin promote` output."
      );
    }
    persistSession(session);
    await normalizeUser(ctx, session);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Reset the canonical non-admin to role=user. The promote/demote test ends in
 * a demoted state, but a previously-aborted run could leave them promoted —
 * normalizing here keeps that test's starting assumption deterministic.
 */
async function normalizeUser(
  ctx: import("@playwright/test").APIRequestContext,
  session: AuthSession
): Promise<void> {
  const res = await ctx.get(`${BASE_URL}/_api/admin/users`, { headers: bearer(session) });
  const users = (await res.json()).data as { id: number; email: string; role: string }[];
  const target = users.find((u) => u.email === USER_EMAIL);
  if (target && target.role !== "user") {
    await ctx.patch(`${BASE_URL}/_api/admin/users/${target.id}/role`, {
      headers: bearer(session),
      data: { role: "user" },
    });
  }
}

/** Write a Playwright storageState file containing the admin session. */
function persistSession(session: unknown): void {
  mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const state = {
    cookies: [],
    origins: [
      {
        origin: APP_ORIGIN,
        localStorage: [{ name: SESSION_KEY, value: JSON.stringify(session) }],
      },
    ],
  };
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
}

/** Fail fast if `/admin` is serving the placeholder instead of the React SPA. */
async function assertAdminBundleServed(): Promise<void> {
  const res = await fetch(`${BASE_URL}/admin?_=${Date.now()}`);
  const html = await res.text();
  if (!/\/admin\/assets\//.test(html)) {
    throw new Error(
      `The admin SPA bundle is not being served at ${BASE_URL}/admin ` +
        "(got the placeholder, not the built React app). " +
        "Build it first with `npm run build` (or `npm run admin:build`), then re-run E2E."
    );
  }
}
