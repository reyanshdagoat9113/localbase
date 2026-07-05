import { useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  useAdminRequests,
  useApproveAdminRequest,
  useRejectAdminRequest,
} from "@/hooks/useAdmin";
import { ApiError } from "@/lib/api";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

export function AdminRequestsView() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const requests = useAdminRequests(isOwner);
  const approve = useApproveAdminRequest();
  const reject = useRejectAdminRequest();
  const [error, setError] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <ErrorState error={new Error("Only the owner can manage admin requests.")} />
    );
  }
  if (requests.isLoading) return <LoadingState />;
  if (requests.error) return <ErrorState error={requests.error} />;

  const list = requests.data?.requests ?? [];

  return (
    <>
      <PageHeader
        title="Admin Requests"
        description="Review account creation and promotion requests. Approval grants full administrator access."
      />

      {error ? (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}

      <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground">
          {list.length} pending
        </span>
        <span>Requests are processed oldest first.</span>
      </div>

      {list.length === 0 ? (
        <Panel>
          <div className="py-10 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full border border-border bg-accent text-lg">
              ✓
            </div>
            <h2 className="font-medium">The queue is clear</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              New admin requests will appear here.
            </p>
          </div>
        </Panel>
      ) : (
        <div className="space-y-3">
          {list.map((request) => {
            const pending = approve.isPending || reject.isPending;
            const isPromotion = request.kind === "promote";
            return (
              <article
                key={request.id}
                className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={
                          isPromotion
                            ? "rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                            : "rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"
                        }
                      >
                        {isPromotion ? "Promote user" : "New account"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(request.created_at)}
                      </span>
                    </div>
                    <p className="truncate font-medium">{request.email}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isPromotion
                        ? "This existing user verified their password and requested administrator access."
                        : "Approval will create a new administrator account."}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        setError(null);
                        try {
                          await reject.mutateAsync(request.id);
                        } catch (err) {
                          setError(toMessage(err));
                        }
                      }}
                      className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        setError(null);
                        try {
                          await approve.mutateAsync(request.id);
                        } catch (err) {
                          setError(toMessage(err));
                        }
                      }}
                      className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error
    ? error.message
    : "Request failed";
}
