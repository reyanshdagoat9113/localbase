import { QueryBuilder } from "./query-builder.js";
import { createAuthClient, type AuthClient } from "./auth-client.js";
import type { StoredSession } from "./auth.js";

export interface LocalBaseClient {
  from<T = unknown>(table: string): QueryBuilder<T>;
  auth: AuthClient;
}

/**
 * Create a LocalBase SDK client.
 *
 * The returned object holds session state in a closure, so `db.auth.signIn`
 * and `db.from(...).select(...)` always see the same token. Persist the
 * session with `db.auth.setSession(...)` to survive page reloads.
 *
 * @example
 * ```ts
 * const db = createClient("http://localhost:5180");
 * await db.auth.signIn({ email, password });
 * const user = await db.auth.getUser();
 * const posts = await db.from("posts").select("*");
 * ```
 */
export function createClient(url: string): LocalBaseClient {
  const baseUrl = url.replace(/\/+$/, "");

  // Session state lives in the closure. Both `auth` and the query builder
  // read through the getter, so signIn → query always picks up the new token.
  let session: StoredSession | null = null;
  const getSession = () => session;
  const setSession = (s: StoredSession | null) => {
    session = s;
  };

  const auth = createAuthClient(baseUrl, getSession, setSession);

  return {
    from<T = unknown>(table: string): QueryBuilder<T> {
      return new QueryBuilder<T>(baseUrl, table, () => session?.accessToken);
    },
    auth,
  };
}
