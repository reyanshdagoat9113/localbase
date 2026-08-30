import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getMeta,
  getSession,
  signIn as apiSignIn,
  signOut as apiSignOut,
  createOwner as apiCreateOwner,
  subscribeSession,
  type AuthSession,
  type AuthUser,
} from "@/lib/api";

interface AuthContextValue {
  session: AuthSession | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  /**
   * Whether the server has auth enabled. `null` until `/_api/admin/meta`
   * answers. When `false` the Studio runs in ungated mode: no login screen,
   * no user-management surface.
   */
  authEnabled: boolean | null;
  signIn: (email: string, password: string) => Promise<AuthSession>;
  createOwner: (email: string, password: string) => Promise<AuthSession>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() =>
    getSession()
  );
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => subscribeSession(setSessionState), []);

  useEffect(() => {
    let cancelled = false;
    getMeta()
      .then((meta) => {
        if (!cancelled) setAuthEnabled(meta.authEnabled);
      })
      .catch(() => {
        // Can't tell — assume the safe (gated) posture so the login flow
        // at least surfaces a real error instead of a blank screen.
        if (!cancelled) setAuthEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (session === null) queryClient.clear();
  }, [queryClient, session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: session !== null,
      authEnabled,
      signIn: apiSignIn,
      createOwner: apiCreateOwner,
      signOut: apiSignOut,
    }),
    [session, authEnabled]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
