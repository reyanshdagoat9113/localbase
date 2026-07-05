import fs from "node:fs";
import { Cron } from "croner";
import { Database, Scheduler, JobError } from "@localbase/core";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

/**
 * Open the database and construct a (not-yet-started) {@link Scheduler} for
 * the registered jobs. Mirrors the `openAuthDb` helper in `auth.ts`/`admin.ts`:
 * load the config, provision `.localbase/`, hand `jobs` to the `Database` so
 * `_job_runs` is provisioned, and wrap the map in a scheduler so the CLI reads
 * go through the same readers the admin API / `dev` use.
 *
 * The scheduler is **not** started here — read commands (`list`/`logs`) must
 * be side-effect-free (no timer arming, no risk of a stray firing), and the
 * manual trigger (`run`) calls `scheduler.runNow`, which works without `start`.
 * `nextRun` for `list` is previewed directly via `croner` (see
 * {@link previewNextRun}) so the value matches what `dev` would compute
 * without arming a live timer.
 */
function openJobsDb(): Promise<{ db: Database; scheduler: Scheduler }> {
  const cwd = process.cwd();
  return loadConfig(cwd).then(({ dbPath, dbDir, config }) => {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const jobs = config.jobs ?? {};
    const db = new Database({
      path: dbPath,
      schema: config.tables,
      auth: config.auth,
      dataDir: dbDir,
      buckets: config.buckets,
      jobs: config.jobs,
    });
    const scheduler = new Scheduler({ db, cwd, jobs });
    return { db, scheduler };
  });
}

/**
 * Compute the next scheduled fire time for a job's schedule without arming a
 * live timer. Creating a `Cron` with no callback (then reading `nextRun()`
 * and stopping) is the same side-effect-free pattern the config validator
 * uses, and yields the same value `Scheduler.start` would produce — so
 * `jobs list` and the running `dev` process always agree on `nextRun`.
 */
function previewNextRun(schedule: string, timezone?: string): Date | null {
  const cron = new Cron(schedule, { timezone });
  const next = cron.nextRun();
  cron.stop();
  return next;
}

/** Format a Date/ISO string as a short local timestamp, or `—` when absent. */
function fmtTime(value: Date | string | null): string {
  if (value === null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Render a duration in milliseconds as a compact human string. */
function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format a job's enabled state for display (`enabled` / `paused`). */
function fmtEnabled(enabled: boolean): string {
  return enabled ? "enabled" : "paused";
}

function handleJobsError(err: unknown): never {
  if (err instanceof JobError) {
    log.error(err.message);
  } else if (err instanceof Error) {
    log.error(err.message);
  } else {
    log.error(String(err));
  }
  process.exit(1);
}

interface RunRow {
  id: number;
  job_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
}

/** Read a single `_job_runs` row by id (the manual-run result). */
function readRunById(db: Database, runId: number | null): RunRow | null {
  if (runId === null) return null;
  const rows = db.select("_job_runs", {
    filters: [{ column: "id", operator: "eq", value: runId }],
  }) as RunRow[];
  return rows[0] ?? null;
}

// ── localbase jobs list ────────────────────────────────────────

export async function listJobsCommand(): Promise<void> {
  let db: Database | null = null;
  try {
    const opened = await openJobsDb();
    db = opened.db;

    // listJobs() returns lastRun/lastStatus from `_job_runs` without needing
    // the scheduler to be started; only `nextRun` is null until armed, so we
    // overlay a croner preview to keep the read side-effect-free.
    const summaries = opened.scheduler.listJobs().map((s) => ({
      ...s,
      nextRun: s.enabled ? previewNextRun(s.schedule, s.timezone) : null,
    }));

    if (summaries.length === 0) {
      log.info(
        "No jobs configured. Add a `jobs` map to localbase.config.ts to schedule one."
      );
      return;
    }

    log.heading(`Jobs (${summaries.length}):`);
    for (const s of summaries) {
      const next = fmtTime(s.nextRun);
      const last = s.lastRun
        ? `${fmtTime(s.lastRun)} (${s.lastStatus ?? "?"})`
        : "never";
      console.log(
        `  ${s.name}  [${fmtEnabled(s.enabled)}]  ${s.schedule}` +
          (s.timezone ? `  (${s.timezone})` : "") +
          `\n      next: ${next}    last: ${last}`
      );
      if (s.description) {
        console.log(`      ${s.description}`);
      }
    }
  } catch (err) {
    handleJobsError(err);
  } finally {
    if (db) db.close();
  }
}

// ── localbase jobs run <name> ──────────────────────────────────

export interface RunJobOptions {
  name: string;
}

export async function runJobCommand(opts: RunJobOptions): Promise<void> {
  if (!opts.name) {
    log.error("Job name is required: `localbase jobs run <name>`.");
    process.exit(1);
  }

  let db: Database | null = null;
  try {
    const opened = await openJobsDb();
    db = opened.db;

    const result = await opened.scheduler.runNow(opts.name);
    const row = readRunById(opened.db, result.runId);

    if (result.status === "skipped") {
      log.warn(
        `Skipped "${opts.name}": a run is already in progress. Try again in a moment.`
      );
    } else if (result.status === "success") {
      log.success(
        `Ran "${opts.name}" — run #${result.runId} (${fmtDuration(row?.duration_ms)})`
      );
    } else {
      log.error(
        `Ran "${opts.name}" — run #${result.runId} failed: ${row?.error ?? "unknown error"}`
      );
    }
    if (row?.output) {
      log.info("Output:");
      console.log(indent(row.output, "    "));
    }

    // A non-success outcome (failed/skipped) is observable in the exit code so
    // `jobs run && …` scripts only proceed when the run actually succeeded.
    if (result.status !== "success") {
      process.exit(1);
    }
  } catch (err) {
    handleJobsError(err);
  } finally {
    if (db) db.close();
  }
}

// ── localbase jobs logs <name> ─────────────────────────────────

export interface JobLogsOptions {
  name: string;
  /** Max runs to show (newest first). Default 10. */
  limit?: number;
}

export async function jobLogsCommand(opts: JobLogsOptions): Promise<void> {
  if (!opts.name) {
    log.error("Job name is required: `localbase jobs logs <name>`.");
    process.exit(1);
  }

  let db: Database | null = null;
  try {
    const opened = await openJobsDb();
    db = opened.db;

    const limit = opts.limit ?? 10;
    const { runs, total } = opened.scheduler.getRuns(opts.name, { limit });

    log.heading(`Runs for "${opts.name}" (${total} total, showing ${runs.length}):`);
    if (runs.length === 0) {
      log.info("  No runs recorded yet.");
      return;
    }

    for (const r of runs) {
      const status = r.status;
      const line =
        `  #${r.id}  ${fmtTime(r.started_at)}  ${status}  ${fmtDuration(r.duration_ms)}`;
      console.log(line);
      if (r.status === "failed" && r.error) {
        console.log(indent(`error: ${r.error}`, "      "));
      }
      if (r.output) {
        console.log(indent(truncateLines(r.output, 5), "      "));
      }
    }
  } catch (err) {
    handleJobsError(err);
  } finally {
    if (db) db.close();
  }
}

/** Indent every line of `s` with `prefix`. */
function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

/** Keep at most `maxLines` lines of `s`, marking truncation. */
function truncateLines(s: string, maxLines: number): string {
  const lines = s.split("\n");
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join("\n") + "\n…[output truncated]";
}
