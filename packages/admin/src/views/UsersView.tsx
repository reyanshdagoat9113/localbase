import { useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import {
  useUsers,
  useCreateUser,
  useResetUserPassword,
  useSetUserRole,
  type AuthUser,
} from "@/hooks/useAdmin";
import { ApiError } from "@/lib/api";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";
import { cn } from "@/lib/utils";

/**
 * Auth Manager. Lists every user and lets an admin create users, reset
 * passwords, and promote/demote — all through the typed `/_api/admin/users/*`
 * endpoints (never the generic row API, which refuses `_users` writes).
 *
 * Lockout / self-demotion rules mirror the backend:
 *   - The last admin cannot be demoted (button disabled; backend enforces too).
 *   - Demoting yourself revokes your own admin access, so it requires an extra
 *     confirmation and signs you out on success.
 */
export function UsersView() {
  const { user: currentUser, signOut } = useAuth();
  const { data: users, isLoading, error } = useUsers();
  const create = useCreateUser();
  const resetPassword = useResetUserPassword();
  const setRole = useSetUserRole();

  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<AuthUser | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  const list = users ?? [];
  const adminCount = list.filter(
    (u) => u.role === "admin" || u.role === "owner"
  ).length;

  async function promote(user: AuthUser) {
    setBannerError(null);
    try {
      await setRole.mutateAsync({ id: user.id, role: "admin" });
    } catch (err) {
      setBannerError(toMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Create users, reset passwords, and manage admin roles."
      />
      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            + New user
          </button>
          <span className="text-xs text-muted-foreground">
            {list.length} {list.length === 1 ? "user" : "users"} ·{" "}
            {adminCount} {adminCount === 1 ? "admin" : "admins"}
          </span>
        </div>

        {bannerError ? (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
            {bannerError}
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-4">ID</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((user) => {
                const isSelf = currentUser?.id === user.id;
                const isOwner = user.role === "owner";
                const isLastAdmin = user.role === "admin" && adminCount <= 1;
                return (
                  <tr
                    key={user.id}
                    className="border-b border-border hover:bg-accent/30"
                  >
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {user.id}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-medium">{user.email}</span>
                      {isSelf ? (
                        <span className="ml-2 rounded-full bg-accent px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          you
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {formatDate(user.created_at)}
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={isOwner && !isSelf}
                          title={
                            isOwner && !isSelf
                              ? "The owner's password cannot be reset by another admin"
                              : undefined
                          }
                          onClick={() => setResetTarget(user)}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Reset password
                        </button>
                        {isOwner ? null : user.role === "user" ? (
                          <button
                            type="button"
                            disabled={setRole.isPending}
                            onClick={() => promote(user)}
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          >
                            Promote
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isLastAdmin || setRole.isPending}
                            title={
                              isLastAdmin
                                ? "Cannot demote the last admin"
                                : undefined
                            }
                            onClick={() => setDemoteTarget(user)}
                            className={cn(
                              "rounded-md border border-border px-2 py-1 text-xs hover:bg-accent",
                              isLastAdmin && "cursor-not-allowed opacity-50"
                            )}
                          >
                            Demote
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {showCreate && (
        <CreateUserDialog
          isSubmitting={create.isPending}
          onSubmit={async (email, password) => {
            await create.mutateAsync({ email, password });
            setShowCreate(false);
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {resetTarget && (
        <ResetPasswordDialog
          user={resetTarget}
          isSubmitting={resetPassword.isPending}
          onSubmit={async (password) => {
            await resetPassword.mutateAsync({
              id: resetTarget.id,
              password,
            });
            setResetTarget(null);
          }}
          onClose={() => setResetTarget(null)}
        />
      )}

      {demoteTarget && (
        <DemoteConfirmDialog
          user={demoteTarget}
          isSelf={currentUser?.id === demoteTarget.id}
          isSubmitting={setRole.isPending}
          onConfirm={async () => {
            try {
              await setRole.mutateAsync({
                id: demoteTarget.id,
                role: "user",
              });
              setDemoteTarget(null);
              // Self-demotion revokes our own admin access; the next gated
              // request would 403, so sign out cleanly instead of stranding
              // the operator on a broken session.
              if (currentUser?.id === demoteTarget.id) {
                await signOut();
              }
            } catch (err) {
              setDemoteTarget(null);
              setBannerError(toMessage(err));
            }
          }}
          onClose={() => setDemoteTarget(null)}
        />
      )}
    </>
  );
}

function RoleBadge({ role }: { role: AuthUser["role"] }) {
  if (role === "owner") {
    return (
      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        owner
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
        admin
      </span>
    );
  }
  return (
    <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
      user
    </span>
  );
}

function formatDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function toMessage(err: unknown): string {
  return err instanceof ApiError || err instanceof Error
    ? err.message
    : "Request failed";
}

// ─── Dialogs ────────────────────────────────────────────────────

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

function CreateUserDialog({
  isSubmitting,
  onSubmit,
  onClose,
}: {
  isSubmitting: boolean;
  onSubmit: (email: string, password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setError(toMessage(err));
    }
  }

  return (
    <DialogShell title="Create user" onClose={onClose}>
      <div className="mt-4 space-y-3">
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            className={inputClass}
            autoFocus
          />
        </Field>
        <Field label="Password">
          <PasswordInput
            value={password}
            onChange={setPassword}
            show={show}
            onToggle={() => setShow((s) => !s)}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            New users start as role=user; promote after creating.
          </span>
        </Field>
        {error ? (
          <p className="text-sm text-destructive-foreground">{error}</p>
        ) : null}
      </div>
      <DialogActions
        onClose={onClose}
        onSubmit={submit}
        isSubmitting={isSubmitting}
        submitLabel="Create"
      />
    </DialogShell>
  );
}

function ResetPasswordDialog({
  user,
  isSubmitting,
  onSubmit,
  onClose,
}: {
  user: AuthUser;
  isSubmitting: boolean;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(toMessage(err));
    }
  }

  return (
    <DialogShell title="Reset password" onClose={onClose}>
      <p className="mt-2 text-sm text-muted-foreground">
        Set a new password for <code>{user.email}</code>. Existing sessions are
        not revoked by this action.
      </p>
      <div className="mt-4 space-y-3">
        <Field label="New password">
          <PasswordInput
            value={password}
            onChange={setPassword}
            show={show}
            onToggle={() => setShow((s) => !s)}
          />
        </Field>
        {error ? (
          <p className="text-sm text-destructive-foreground">{error}</p>
        ) : null}
      </div>
      <DialogActions
        onClose={onClose}
        onSubmit={submit}
        isSubmitting={isSubmitting}
        submitLabel="Reset password"
      />
    </DialogShell>
  );
}

function DemoteConfirmDialog({
  user,
  isSelf,
  isSubmitting,
  onConfirm,
  onClose,
}: {
  user: AuthUser;
  isSelf: boolean;
  isSubmitting: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <DialogShell title="Demote to user?" onClose={onClose}>
      <p className="mt-2 text-sm text-muted-foreground">
        Demote <code>{user.email}</code> from admin to user. They will lose
        access to the admin API.
        {isSelf
          ? " This revokes your own admin access and will sign you out."
          : ""}
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isSubmitting}
          onClick={onConfirm}
          className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
        >
          {isSubmitting ? "Demoting…" : "Demote"}
        </button>
      </div>
    </DialogShell>
  );
}

function PasswordInput({
  value,
  onChange,
  show,
  onToggle,
}: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex gap-2">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
      >
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function DialogActions({
  onClose,
  onSubmit,
  isSubmitting,
  submitLabel,
}: {
  onClose: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className="mt-6 flex justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={isSubmitting}
        onClick={onSubmit}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {isSubmitting ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}
