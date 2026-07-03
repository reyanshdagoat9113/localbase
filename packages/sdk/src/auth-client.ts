import type {
  AuthResponse,
  SignInResponse,
  StoredSession,
} from "./auth.js";

/**
 * Server-returned shape for a successful signup / signin / refresh. Mirrors
 * the `data` envelope the API uses for all responses.
 */
interface AuthEnvelope {
  data?: StoredSession;
  error?: string;
}

interface UserEnvelope {
  data?: { user: { id: number; email: string; created_at?: string } };
  error?: string;
}

/**
 * Read/write access to the current session. The factory is created once
 * per `createClient` call and shared between `db.auth` and `db.from`, so
 * signing in immediately makes the token available to data queries.
 */
export function createAuthClient(
  baseUrl: string,
  getSession: () => StoredSession | null,
  setSession: (s: StoredSession | null) => void
) {
  /**
   * Internal — posts JSON, parses the standard envelope, and stores the
   * session on success. Used by signUp, signIn, and refresh.
   */
  async function exchange(
    path: string,
    body: Record<string, unknown>
  ): Promise<AuthResponse> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AuthEnvelope;
      if (!res.ok || json.error) {
        return { data: null, error: json.error ?? `Request failed: ${res.status}` };
      }
      if (!json.data) {
        return { data: null, error: "Empty response from server" };
      }
      setSession(json.data);
      return { data: json.data, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  return {
    /**
     * Create a new account and start a session.
     * Throws no exceptions — returns `{ data, error }` like every other
     * SDK call.
     */
    async signUp(args: {
      email: string;
      password: string;
    }): Promise<AuthResponse> {
      return exchange("/api/auth/signup", args);
    },

    /**
     * Sign in to an existing account.
     */
    async signIn(args: {
      email: string;
      password: string;
    }): Promise<AuthResponse> {
      return exchange("/api/auth/signin", args);
    },

    /**
     * Invalidate the current refresh token on the server and clear local
     * state. Idempotent — calling it when already signed out is fine.
     */
    async signOut(): Promise<{ data: null; error: string | null }> {
      const session = getSession();
      // Always clear local state, even if the network call fails.
      setSession(null);

      if (!session) {
        return { data: null, error: null };
      }

      try {
        const res = await fetch(`${baseUrl}/api/auth/signout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (!res.ok) {
          // Local state is cleared; surface the server error but don't
          // throw — the local goal of "you're signed out" is achieved.
          const json = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          return { data: null, error: json.error ?? `Signout failed: ${res.status}` };
        }
        return { data: null, error: null };
      } catch (err) {
        return {
          data: null,
          error: err instanceof Error ? err.message : "Network error",
        };
      }
    },

    /**
     * Fetch the current user from the server. Requires a valid session.
     */
    async getUser(): Promise<SignInResponse> {
      const session = getSession();
      if (!session) {
        return { data: null, error: "Not signed in" };
      }
      try {
        const res = await fetch(`${baseUrl}/api/auth/user`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        const json = (await res.json()) as UserEnvelope;
        if (!res.ok || json.error) {
          // Token might be expired — caller can try `refresh()`.
          return {
            data: null,
            error: json.error ?? `Request failed: ${res.status}`,
          };
        }
        return { data: json.data ?? null, error: null };
      } catch (err) {
        return {
          data: null,
          error: err instanceof Error ? err.message : "Network error",
        };
      }
    },

    /**
     * Rotate the access + refresh token. Use after a 401 to recover from
     * a near-expired access token without making the user re-authenticate.
     */
    async refresh(): Promise<AuthResponse> {
      const session = getSession();
      if (!session) {
        return { data: null, error: "No active session to refresh" };
      }
      return exchange("/api/auth/refresh", {
        refreshToken: session.refreshToken,
      });
    },

    /**
     * Manually set the session — useful for hydrating from `localStorage`
     * on page load:
     *
     * ```ts
     * const stored = localStorage.getItem("localbase-session");
     * if (stored) db.auth.setSession(JSON.parse(stored));
     * ```
     */
    setSession(session: StoredSession | null): void {
      setSession(session);
    },

    /**
     * Read the current session. `null` when signed out.
     */
    getSession(): StoredSession | null {
      return getSession();
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
