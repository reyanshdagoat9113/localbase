// Jobs subsystem barrel.
//
// The scheduled-jobs surface: a system table (`_job_runs`), a runner that
// loads + executes declared handlers and records every run, and the handler
// contract types. The scheduler (cron-driven lifecycle) and the admin/CLI
// readers land in later milestones; this barrel exposes only what M2 owns.

export { JOBS_SCHEMA } from "./schema.js";
export {
  JobRunner,
  JobError,
  JobHandlerLoadError,
} from "./runner.js";
export type { JobRunnerOptions, JobRunResult } from "./runner.js";
export type { JobContext, JobHandler } from "./types.js";
