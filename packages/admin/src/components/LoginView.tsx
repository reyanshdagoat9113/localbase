import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

export function LoginView() {
  const { isAuthenticated, signIn, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) return <Navigate to="/tables" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session =
        mode === "signin"
          ? await signIn(email, password)
          : await signUp(email, password);
      if (session.user.role !== "admin") {
        setError("This account is not an admin.");
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
            Sign in with an admin account, or create the first admin on a fresh
            database.
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

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-60"
        >
          {loading ? "Working..." : mode === "signin" ? "Sign in" : "Create admin"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="mt-3 w-full text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "Create the first admin" : "Use an existing admin"}
        </button>
      </form>
    </div>
  );
}
