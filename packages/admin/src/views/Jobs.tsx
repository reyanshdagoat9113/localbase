import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useJobRuns, useJobs, useRunJob } from "@/hooks/useAdmin";
import { ApiError, getSession, type JobRun, type JobSummary } from "@/lib/api";
import { ErrorState, LoadingState, PageHeader, Panel } from "@/views/State";

const PAGE_SIZE = 10;

export function JobsView() {
  const jobs = useJobs();
  const [selectedName, setSelectedName] = useState("");
  const [page, setPage] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const runJob = useRunJob();

  useJobRunRealtime();

  const list = jobs.data ?? [];
  const activeName = list.some((job) => job.name === selectedName)
    ? selectedName
    : (list[0]?.name ?? "");
  const activeJob = list.find((job) => job.name === activeName) ?? null;
  const history = useJobRuns(activeName, PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [activeName]);

  if (jobs.isLoading) return <LoadingState />;
  if (jobs.error) return <ErrorState error={jobs.error} />;

  async function trigger(name: string) {
    setActionError(null);
    try {
      await runJob.mutateAsync(name);
    } catch (error) {
      setActionError(toMessage(error));
    }
  }

  return (
    <>
      <PageHeader
        title="Scheduled Jobs"
        description="Inspect declared cron jobs, trigger a run, and follow output as it completes."
      />

      {actionError ? (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
          {actionError}
        </p>
      ) : null}

      {list.length === 0 ? (
        <Panel>
          <div className="py-10 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full border border-border bg-accent font-mono text-sm">
              */*
            </div>
            <h2 className="font-medium">No jobs registered</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a <code className="font-mono">jobs</code> map to localbase.config.ts.
            </p>
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,1.6fr)]">
          <Panel>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Registry</h2>
              <span className="font-mono text-xs text-muted-foreground">
                {list.length} {list.length === 1 ? "job" : "jobs"}
              </span>
            </div>
            <div className="space-y-1">
              {list.map((job) => (
                <JobListItem
                  key={job.name}
                  job={job}
                  active={job.name === activeName}
                  onSelect={() => setSelectedName(job.name)}
                />
              ))}
            </div>
          </Panel>

          <div className="min-w-0 space-y-4">
            {activeJob ? (
              <JobDetail
                job={activeJob}
                running={runJob.isPending}
                onRun={() => void trigger(activeJob.name)}
              />
            ) : null}

            <Panel>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Run history</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Newest attempts first. Output may contain sensitive operator logs.
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {history.data?.total ?? 0} total
                </span>
              </div>

              {history.isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading runs…</p>
              ) : history.error ? (
                <ErrorState error={history.error} />
              ) : (
                <RunHistory runs={history.data?.runs ?? []} />
              )}

              {(history.data?.total ?? 0) > PAGE_SIZE ? (
                <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-xs">
                  <span className="text-muted-foreground">
                    Page {page + 1} of {Math.ceil((history.data?.total ?? 0) / PAGE_SIZE)}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={page === 0}
                      onClick={() => setPage((value) => Math.max(0, value - 1))}
                      className="rounded-md border border-border px-2.5 py-1.5 hover:bg-accent disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={(page + 1) * PAGE_SIZE >= (history.data?.total ?? 0)}
                      onClick={() => setPage((value) => value + 1)}
                      className="rounded-md border border-border px-2.5 py-1.5 hover:bg-accent disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : null}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function JobListItem({
  job,
  active,
  onSelect,
}: {
  job: JobSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
        active
          ? "border-primary/30 bg-accent"
          : "border-transparent hover:border-border hover:bg-accent/50"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-sm font-medium">{job.name}</span>
        <StatusDot status={job.enabled ? job.lastStatus : "paused"} />
      </span>
      <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
        {job.schedule} {job.timezone ? `· ${job.timezone}` : "· server time"}
      </span>
    </button>
  );
}

function JobDetail({
  job,
  running,
  onRun,
}: {
  job: JobSummary;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <Panel>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-mono text-lg font-semibold">{job.name}</h2>
            <StatusBadge status={job.enabled ? job.lastStatus : "paused"} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {job.description ?? "No description provided."}
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={onRun}
          className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {running ? "Starting…" : "Run now"}
        </button>
      </div>
      <dl className="mt-5 grid gap-3 border-t border-border pt-4 text-xs sm:grid-cols-3">
        <Fact label="Schedule" value={job.schedule} mono />
        <Fact label="Next run" value={formatDate(job.nextRun)} />
        <Fact label="Last run" value={formatDate(job.lastRun)} />
      </dl>
    </Panel>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`mt-1 truncate ${mono ? "font-mono" : "font-medium"}`}>{value}</dd>
    </div>
  );
}

function RunHistory({ runs }: { runs: JobRun[] }) {
  if (runs.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">This job has not run yet.</p>;
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <details key={run.id} className="group rounded-lg border border-border bg-background">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 text-sm">
            <StatusDot status={run.status} />
            <span className="font-mono text-xs">#{run.id}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{formatDate(run.started_at)}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {run.duration_ms === null ? "running" : formatDuration(run.duration_ms)}
            </span>
            <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="border-t border-border px-3 py-3">
            {run.error ? <LogBlock label="Error" value={run.error} error /> : null}
            {run.output ? <LogBlock label="Output" value={run.output} /> : null}
            {!run.error && !run.output ? (
              <p className="text-xs text-muted-foreground">No output recorded.</p>
            ) : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function LogBlock({ label, value, error = false }: { label: string; value: string; error?: boolean }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wider ${error ? "text-destructive" : "text-muted-foreground"}`}>{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{value}</pre>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? "never run";
  return <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>;
}

function StatusDot({ status }: { status: string | null }) {
  const color = status === "success"
    ? "bg-emerald-500"
    : status === "failed"
      ? "bg-red-500"
      : status === "running"
        ? "bg-amber-500 animate-pulse"
        : "bg-slate-400";
  return <span className={`size-2 shrink-0 rounded-full ${color}`} title={status ?? "Never run"} />;
}

function useJobRunRealtime() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const token = getSession()?.accessToken;
      const url = `${protocol}//${window.location.host}/realtime${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "subscribe", id: "admin-jobs", table: "_job_runs" }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; event?: { table?: string } };
          if (message.type === "event" && message.event?.table === "_job_runs") {
            queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
          }
        } catch {
          // Ignore malformed/non-JSON realtime messages.
        }
      });
      socket.addEventListener("close", () => {
        if (!closed) reconnect = setTimeout(connect, 1500);
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
    };
  }, [queryClient]);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function toMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "Request failed";
}
