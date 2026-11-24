import path from "node:path";
import { createJiti } from "jiti";
import type { JobConfig } from "@localbase/shared";
import type { Database } from "../db.js";
import type { JobHandler } from "./types.js";

/**
 * Maximum number of bytes of `output`/`error` retained per run. A chatty
 * handler could otherwise bloat `_job_runs` (see Risks #5 in the jobs plan);
 * we truncate rather than reject so the run still completes. 64 KiB matches
 * common log-line budgets.
 */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Marker prepended to a run row's `output` when the handler could not be
 * loaded (non-function default export, missing file, etc.). Kept distinct
 * from a handler's own `log()` lines so the failure is obvious in the viewer.
 */
const LOAD_ERROR_SENTINEL = "[handler-load-error]";

/**
 * Result of a single {@link JobRunner.run} invocation. Every scheduled or
 * manual run produces exactly one of these.
 */
export interface JobRunResult {
  /** The `_job_runs.id` for this attempt, or `null` when skipped. */
  runId: number | null;
  /**
   * - `"success"` — handler resolved; row updated to success.
   * - `"failed"` — handler threw or could not be loaded; row updated to failed.
   * - `"skipped"` — the job was already running; no row written (Decision #8).
   */
  status: "success" | "failed" | "skipped";
}

/** Options for constructing a {@link JobRunner}. */
export interface JobRunnerOptions {
  /** The LocalBase database. Must have `jobs` enabled (`_job_runs` provisioned). */
  db: Database;
  /** Project root used to resolve relative `handler` paths. */
  cwd: string;
  /** The registered jobs map (the source of truth, loaded from config). */
  jobs: Record<string, JobConfig>;
}

/** Client-error type for job-runner failures (unknown name, bad handler). */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

/**
 * Loads and executes registered job handlers, recording every run in
 * `_job_runs`.
 *
 * The runner is the sole writer of `_job_runs`: it inserts a `running` row
 * when a job fires and updates it to `success` | `failed` when it finishes.
 * History is append-only — there is no PATCH/DELETE surface. All writes go
 * through {@link Database.insert}/{@link Database.update} so the standard
 * database change-event lifecycle remains intact.
 *
 * Concurrency: an in-memory `Set` of running names enforces one execution at
 * a time per job. If a job is still running when its next schedule fires,
 * the firing is **skipped** (no row, no queueing) — see Decision #8.
 */
export class JobRunner {
  private db: Database;
  private cwd: string;
  private jobs: Record<string, JobConfig>;
  /** Names currently executing; membership ⇒ an overlapping firing is skipped. */
  private running = new Set<string>();

  constructor(options: JobRunnerOptions) {
    this.db = options.db;
    this.cwd = options.cwd;
    this.jobs = options.jobs;
  }

  /** Returns the registered config for `name`, or `undefined` if unknown. */
  getJob(name: string): JobConfig | undefined {
    return this.jobs[name];
  }

  /** Returns the names of all registered jobs. */
  getJobNames(): string[] {
    return Object.keys(this.jobs);
  }

  /** True when a job named `name` is currently executing. */
  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /**
   * Run a registered job by name. This is the single funnel through which
   * scheduled, manual-CLI, and manual-admin runs all pass, so `_job_runs`
   * is always consistent.
   *
   * Steps (see the runner block of the jobs architecture diagram):
   *  1. Resolve the name against the registry; unknown → throw {@link JobError}.
   *  2. Concurrency guard: if already running, return `{ status: "skipped" }`.
   *  3. Insert a `running` row (this is the row the viewer/admin/CLI observe).
   *  4. Load the handler via `jiti` (relative to `cwd`, `interopDefault`).
   *  5. Call it with `{ db, log, name }`; collect `log()` lines + return value.
   *  6. Update the row to `success`/`failed` with timing, output, and error.
   *
   * Handler-load failures (missing file, non-function export) are recorded as
   * a `failed` run with the reason in `error` — not thrown — so the scheduler
   * keeps firing the next interval instead of crashing the process.
   *
   * @returns the run id and final status (or `skipped` with no row).
   */
  async run(name: string): Promise<JobRunResult> {
    const started = await this.startRun(name);
    return started.completion;
  }

  /**
   * Start a registered job and resolve as soon as its `running` row has been
   * inserted into `_job_runs`, returning `{ runId, completion }`.
   */
  async startRun(
    name: string
  ): Promise<{ runId: number | null; completion: Promise<JobRunResult> }> {
    const job = this.jobs[name];
    if (!job) {
      throw new JobError(`Unknown job: "${name}"`);
    }

    if (this.running.has(name)) {
      return {
        runId: null,
        completion: Promise.resolve({ runId: null, status: "skipped" }),
      };
    }

    this.running.add(name);
    const startedAtMs = Date.now();
    const logLines: string[] = [];
    const log = (line: string): void => {
      if (typeof line === "string") logLines.push(line);
    };

    let runId: number;
    try {
      const startedAtIso = new Date(startedAtMs).toISOString();
      const inserted = (await this.db.insert("_job_runs", {
        job_name: name,
        status: "running",
        started_at: startedAtIso,
      })) as Array<{ id: number }>;
      runId = inserted[0].id;
    } catch (err) {
      this.running.delete(name);
      throw err;
    }

    const completion = (async (): Promise<JobRunResult> => {
      try {
        const handler = await this.loadHandler(job.handler);
        const returnValue = await handler({ db: this.db, log, name });
        const output = buildOutput(logLines, returnValue);

        await this.db.update(
          "_job_runs",
          {
            status: "success",
            ended_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAtMs,
            output,
          },
          [{ column: "id", operator: "eq", value: runId }]
        );
        return { runId, status: "success" };
      } catch (err) {
        const message = errorMessage(err);
        const output =
          isLoadError(err) && logLines.length === 0
            ? LOAD_ERROR_SENTINEL
            : buildOutput(logLines, undefined);

        await this.db.update(
          "_job_runs",
          {
            status: "failed",
            ended_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAtMs,
            output,
            error: message,
          },
          [{ column: "id", operator: "eq", value: runId }]
        );
        return { runId, status: "failed" };
      } finally {
        this.running.delete(name);
      }
    })();

    return { runId, completion };
  }

  /**
   * Import a handler file via the same `jiti` + `interopDefault` path the
   * config loader uses, then validate the export is callable. Throws
   * {@link JobHandlerLoadError} on any failure so {@link run} can record it
   * as a normal failed run instead of propagating an opaque jiti error.
   */
  private async loadHandler(handlerPath: string): Promise<JobHandler> {
    const resolved = path.resolve(this.cwd, handlerPath);
    let imported: unknown;
    try {
      const jiti = createJiti(this.cwd, { interopDefault: true });
      imported = await jiti.import(resolved);
    } catch (err) {
      throw new JobHandlerLoadError(
        `Could not load job handler "${handlerPath}": ${errorMessage(err)}`
      );
    }

    // Mirror the config loader's defensive unwrap: with `interopDefault`
    // jiti usually returns the default directly, but module shapes vary.
    const handler =
      imported && typeof imported === "object" && "default" in imported
        ? (imported as { default: unknown }).default
        : imported;

    if (typeof handler !== "function") {
      throw new JobHandlerLoadError(
        `Job handler "${handlerPath}" must default-export a function.`
      );
    }
    return handler as JobHandler;
  }
}

/**
 * Distinguished error class for handler-loading failures. {@link JobRunner.run}
 * uses `instanceof` to decide whether to prepend the load-error sentinel to
 * the run's `output`, keeping viewer output readable.
 */
export class JobHandlerLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobHandlerLoadError";
  }
}

function isLoadError(err: unknown): boolean {
  return err instanceof JobHandlerLoadError;
}

/** Safe, non-empty message from any thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Build the stored `output` string for a run: the `log()` lines joined by
 * newlines, optionally followed by the JSON-serialized handler return value.
 * The whole result is truncated to {@link MAX_OUTPUT_BYTES} so a chatty job
 * cannot bloat `_job_runs`.
 */
function buildOutput(logLines: string[], returnValue: unknown): string {
  let output = logLines.join("\n");
  const suffix = serializeReturn(returnValue);
  if (suffix) {
    output = output ? `${output}\n${suffix}` : suffix;
  }
  return truncateToBytes(output, MAX_OUTPUT_BYTES);
}

/** JSON-serialize a non-undefined return value; return "" for nothing to store. */
function serializeReturn(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return String(value);
  }
}

/**
 * Truncate `s` so its UTF-8 encoding is at most `maxBytes`, ending on a
 * character boundary. Appends an ellipsis marker when truncation occurred so
 * the viewer can signal that output was cut.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Walk backward until the slice fits; stop on a character boundary.
  let cut = maxBytes;
  while (cut > 0 && Buffer.byteLength(s.slice(0, cut), "utf8") > maxBytes) {
    cut--;
  }
  const marker = "\n…[output truncated]";
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  // Re-fit the (shorter) slice after reserving space for the marker.
  let kept = cut;
  while (kept > room && Buffer.byteLength(s.slice(0, kept), "utf8") > room) {
    kept--;
  }
  return s.slice(0, kept) + marker;
}
