import { Cron } from "croner";
import type { JobConfig } from "@localbase/shared";
import type { Database } from "../db.js";
import { JobRunner, JobError } from "./runner.js";
import type { JobRunResult } from "./runner.js";

/**
 * A `_job_runs` row, as read back by the scheduler readers. Mirrors
 * {@link JOBS_SCHEMA}; fields are nullable to match SQLite's handling of
 * columns that are only populated once a run finishes.
 */
export interface JobRunRow {
  id: number;
  job_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
}

/** Options for constructing a {@link Scheduler}. */
export interface SchedulerOptions {
  /** The LocalBase database. Must have `jobs` enabled (`_job_runs` provisioned). */
  db: Database;
  /** Project root used to resolve relative `handler` paths (passed to the runner). */
  cwd: string;
  /** The registered jobs map (the source of truth, loaded from config). */
  jobs: Record<string, JobConfig>;
}

/**
 * Summary of a registered job, combining its declared config with live state
 * (next scheduled run) and the most recent recorded run. Returned by
 * {@link Scheduler.listJobs} and rendered by the CLI / admin viewer.
 */
export interface JobSummary {
  name: string;
  schedule: string;
  timezone?: string;
  enabled: boolean;
  description?: string;
  /** Next scheduled fire time, or `null` when paused/disabled/not started. */
  nextRun: Date | null;
  /** `started_at` of the most recent run, or `null` if it has never run. */
  lastRun: string | null;
  /** Status of the most recent run (`"running" | "success" | "failed"`), or `null`. */
  lastStatus: string | null;
}

/** Pagination options for {@link Scheduler.getRuns}. */
export interface GetRunsOptions {
  /** Max rows to return. Default 50. */
  limit?: number;
  /** Number of rows to skip (newest-first). Default 0. */
  offset?: number;
}

/** Result of {@link Scheduler.getRuns}: a page of rows + the unfiltered total. */
export interface GetRunsResult {
  runs: JobRunRow[];
  /** Total rows for this job (ignoring limit/offset), for `X of Y` indicators. */
  total: number;
}

/** Result of starting a manual run without waiting for its handler to finish. */
export interface TriggerJobResult {
  /** The new run id, or `null` when the job is already running. */
  runId: number | null;
  /** Final outcome, useful to process owners that need to drain or observe it. */
  completion: Promise<JobRunResult>;
}

/**
 * Cron-driven process lifecycle for scheduled jobs.
 *
 * The scheduler owns one `croner.Cron` per enabled job. On `start()` it parses
 * each schedule and arms a timer whose callback funnels through the shared
 * {@link JobRunner.run} — the single write path for `_job_runs`. Because the
 * runner writes run-status rows through `Database.insert/update`, every fire
 * follows the normal database change-event lifecycle.
 *
 * Invariants (see the jobs plan, Decisions #7–#9):
 *
 * - **No backfill.** `start()` schedules the next *future* run only (croner's
 *   default). Time the server was down is never replayed.
 * - **Overlap = skip.** The runner's in-memory guard skips a firing whose job
 *   is still running (no queueing, no parallel pile-up for a slow job on a
 *   tight schedule).
 * - **Config is the source of truth.** There is no runtime registration API;
 *   the `jobs` map handed to the constructor is the registry.
 *
 * The scheduler does not enforce cron syntax — that is the config loader's job
 * (M1). By construction time every schedule has already parsed successfully.
 */
export class Scheduler {
  private db: Database;
  private jobs: Record<string, JobConfig>;
  private runner: JobRunner;
  /** Active `croner.Cron` instances, keyed by job name. */
  private crons = new Map<string, Cron>();
  /** Runner promises currently executing (scheduled or manual). */
  private inFlight = new Set<Promise<JobRunResult>>();
  private started = false;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.jobs = options.jobs;
    this.runner = new JobRunner({
      db: options.db,
      cwd: options.cwd,
      jobs: options.jobs,
    });
  }

  /**
   * Arm a `croner.Cron` per enabled job and provision the history index.
   * Idempotent — a second call is a no-op until {@link stop} tears the
   * timers down. Disabled jobs (`enabled: false`) are registered-but-paused:
   * they appear in {@link listJobs} with `nextRun: null` and never fire.
   *
   * Per Decision #9 there is **no backfill**: croner computes the next future
   * match from now, so runs missed while the server was down are not replayed.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.ensureIndexes();
    await this.reconcileOrphanedRuns();

    for (const [name, job] of Object.entries(this.jobs)) {
      // `enabled` defaults to true; an explicit `false` registers-but-pauses.
      if (job.enabled === false) continue;

      const cron = new Cron(
        job.schedule,
        { timezone: job.timezone },
        () => {
          // Fire-and-forget: the runner owns execution + the concurrency guard.
          // Handler failures are recorded as failed runs by the runner; this
          // catch only guards against truly unexpected rejections (e.g. a
          // corrupt `_job_runs`) so one bad firing can't kill the scheduler.
          void this.runTracked(name).catch(() => {
            /* swallow — see comment above */
          });
        }
      );
      this.crons.set(name, cron);
    }

    this.started = true;
  }

  /**
   * Stop every armed timer and drop the `Cron` instances. Safe to call when
   * not started (no-op). After `stop()`, {@link start} can be called again to
   * re-arm (used by config hot-reload in `dev`).
   *
   * In-flight handler executions are *not* cancelled — a handler runs to
   * completion and its row is finalized by the runner. `stop()` only prevents
   * *future* firings.
   */
  stop(): void {
    for (const cron of this.crons.values()) {
      cron.stop();
    }
    this.crons.clear();
    this.started = false;
  }

  /**
   * Wait for every run already handed to the runner to finish. `stop()` only
   * disarms future cron firings; callers that are about to close the Database
   * (notably `localbase dev` hot-reload/shutdown) must await this first so an
   * in-flight handler can finalize its `_job_runs` row before the connection
   * disappears under it.
   */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** True after {@link start} and before {@link stop}. */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Trigger a registered job immediately, outside its cron schedule. This is
   * the manual-run funnel shared by the CLI (`localbase jobs run`) and the
   * admin API (`POST /_api/admin/jobs/:name/run`). It delegates to the runner,
   * so the same concurrency guard and `_job_runs` lifecycle apply — a manual
   * run is indistinguishable from a scheduled one
   * in the history table.
   *
   * @throws {JobError} if `name` is not a registered job.
   */
  async runNow(name: string): Promise<JobRunResult> {
    return this.runTracked(name);
  }

  /**
   * Start a registered job and return as soon as its `running` row exists.
   * The admin trigger endpoint uses this so it can return a run id immediately
   * while readers observe the eventual success/failure update.
   */
  async triggerNow(name: string): Promise<TriggerJobResult> {
    this.requireJob(name);
    const { runId, completion } = await this.runner.startRun(name);
    if (runId !== null) {
      this.inFlight.add(completion);
      completion.finally(() => this.inFlight.delete(completion)).catch(() => {});
    }
    return { runId, completion };
  }

  /** The underlying runner (exposed for advanced/admin introspection). */
  getRunner(): JobRunner {
    return this.runner;
  }

  /** Returns the registered config for `name`, or `undefined` if unknown. */
  getJob(name: string): JobConfig | undefined {
    return this.jobs[name];
  }

  /**
   * Summaries of every registered job, combining declared config, the next
   * scheduled fire time, and the most recent run. Order matches the config
   * map's insertion order. Used by `localbase jobs list` and the admin viewer.
   */
  async listJobs(): Promise<JobSummary[]> {
    const entries = Object.entries(this.jobs);
    const summaries: JobSummary[] = [];
    for (const [name, job] of entries) {
      const enabled = job.enabled !== false;
      const cron = this.crons.get(name);
      const last = await this.latestRun(name);

      summaries.push({
        name,
        schedule: job.schedule,
        timezone: job.timezone,
        enabled,
        description: job.description,
        nextRun: enabled && this.started && cron ? cron.nextRun() : null,
        lastRun: last ? last.started_at : null,
        lastStatus: last ? last.status : null,
      });
    }
    return summaries;
  }

  /**
   * Next scheduled fire time for `name`, or `null` if the job is disabled or
   * the scheduler isn't running.
   *
   * @throws {JobError} if `name` is not a registered job.
   */
  getNextRun(name: string): Date | null {
    this.requireJob(name);
    const job = this.jobs[name];
    if (job.enabled === false || !this.started) return null;
    const cron = this.crons.get(name);
    return cron ? cron.nextRun() : null;
  }

  /**
   * Paginated run history for `name`, newest first.
   *
   * @throws {JobError} if `name` is not a registered job.
   */
  async getRuns(name: string, opts?: GetRunsOptions): Promise<GetRunsResult> {
    this.requireJob(name);
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const filter = [{ column: "job_name", operator: "eq" as const, value: name }];

    const runs = (await this.db.select("_job_runs", {
      filters: filter,
      orderBy: [{ column: "id", direction: "desc" }],
      limit,
      offset,
    })) as JobRunRow[];

    const total = await this.db.count("_job_runs", filter);
    return { runs, total };
  }

  async ensureIndexes(): Promise<void> {
    if (!(await this.hasRunsTable())) return;

    await this.db.execBatch(`
      CREATE INDEX IF NOT EXISTS "_job_runs_name_started_idx"
        ON "_job_runs" ("job_name", "started_at" DESC);
    `);
  }

  private async reconcileOrphanedRuns(): Promise<void> {
    if (!(await this.hasRunsTable())) return;

    await this.db.update(
      "_job_runs",
      {
        status: "failed",
        ended_at: new Date().toISOString(),
        error: "interrupted: server restarted",
      },
      [{ column: "status", operator: "eq", value: "running" }]
    );
  }

  private async hasRunsTable(): Promise<boolean> {
    return this.db.tableExists("_job_runs");
  }

  /** Run through the shared runner while tracking the promise for shutdown drains. */
  private runTracked(name: string): Promise<JobRunResult> {
    const promise = this.runner.run(name);
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
    return promise;
  }

  /** Throw {@link JobError} unless `name` is a registered job. */
  private requireJob(name: string): void {
    if (!(name in this.jobs)) {
      throw new JobError(`Unknown job: "${name}"`);
    }
  }

  /** Newest run row for `name` (or `null`), ordered by id desc. */
  private async latestRun(name: string): Promise<JobRunRow | null> {
    const rows = (await this.db.select("_job_runs", {
      filters: [{ column: "job_name", operator: "eq", value: name }],
      orderBy: [{ column: "id", direction: "desc" }],
      limit: 1,
    })) as JobRunRow[];
    return rows[0] ?? null;
  }
}
