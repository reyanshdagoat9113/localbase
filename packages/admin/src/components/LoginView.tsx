import { FormEvent, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  ApiError,
  getAdminRegistration,
  requestAdminAccess,
} from "@/lib/api";

export function LoginView() {
  const { isAuthenticated, signIn, createOwner } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [ownerExists, setOwnerExists] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getAdminRegistration()
      .then(({ ownerExists }) => setOwnerExists(ownerExists))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Unable to load registration status.")
      );
  }, []);

  if (isAuthenticated) return <Navigate to="/tables" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      if (mode === "signin") {
        const session = await signIn(email, password);
        if (session.user.role !== "admin" && session.user.role !== "owner") {
          setError("This account does not have admin access.");
        }
      } else if (ownerExists === false) {
        await createOwner(email, password);
      } else {
        await requestAdminAccess(email, password);
        setSuccess("Request sent. You can sign in after the owner approves it.");
        setPassword("");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Authentication failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/20"
      >
        <div className="mb-6">
          <p className="text-sm font-medium text-muted-foreground">LocalBase</p>
          <h1 className="mt-1 text-2xl font-semibold">Admin Studio</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {ownerExists === false
              ? "Sign in, or create the owner for this database."
              : "Sign in, or request a new admin account from the owner."}
          </p>
        </div>

        <div className="space-y-4">
          <label className="block text-sm font-medium">
            Email
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 outline-none ring-primary/30 focus:ring-2"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 outline-none ring-primary/30 focus:ring-2"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </div>

        {error ? (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
            {success}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={
            loading || (mode === "register" && ownerExists === null)
          }
          className="mt-6 w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
        >
          {loading
            ? "Working..."
            : mode === "signin"
              ? "Sign in"
              : ownerExists === false
                ? "Create owner"
                : "Request admin account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "register" : "signin");
            setError(null);
            setSuccess(null);
          }}
          className="mt-3 w-full text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "signin"
            ? ownerExists === false
              ? "Create the owner"
              : "Create an admin"
            : "Use an existing admin"}
        </button>
      </form>
    </div>
  );
}
