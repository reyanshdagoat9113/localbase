import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
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
  signIn: (email: string, password: string) => Promise<AuthSession>;
  createOwner: (email: string, password: string) => Promise<AuthSession>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() =>
    getSession()
  );
  const queryClient = useQueryClient();

  useEffect(() => subscribeSession(setSessionState), []);

  useEffect(() => {
    if (session === null) queryClient.clear();
  }, [queryClient, session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isAuthenticated: session !== null,
      signIn: apiSignIn,
      createOwner: apiCreateOwner,
      signOut: apiSignOut,
    }),
    [session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
