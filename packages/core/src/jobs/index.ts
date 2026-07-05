// Jobs subsystem barrel.
//
// The scheduled-jobs surface: a system table (`_job_runs`), a runner that
// loads + executes declared handlers and records every run, the handler
// contract types, and the cron-driven scheduler (process lifecycle). The
// admin/CLI readers and the `dev` integration land in later milestones.

export { JOBS_SCHEMA } from "./schema.js";
export {
  JobRunner,
  JobError,
  JobHandlerLoadError,
} from "./runner.js";
export type { JobRunnerOptions, JobRunResult } from "./runner.js";
export {
  Scheduler,
} from "./scheduler.js";
export type {
  SchedulerOptions,
  JobSummary,
  JobRunRow,
  GetRunsOptions,
  GetRunsResult,
} from "./scheduler.js";
export type { JobContext, JobHandler } from "./types.js";
