import type { DatabaseSchema } from "@localbase/shared";

/**
 * System table provisioned automatically by LocalBase for the scheduled-jobs
 * subsystem. The leading underscore is meaningful: `resetDatabase()` filters
 * out tables whose name starts with `_`, so user resets never wipe run
 * history, and the generic admin row-CRUD endpoints already refuse to write
 * to it (it is pre-registered in the admin system-table gate).
 *
 * The runner is the sole writer: it inserts a `running` row when a job fires
 * and updates it to `success` | `failed` when it finishes. History is
 * append-only — there is no `PATCH`/`DELETE` surface.
 *
 * `output` accumulates `log()` lines plus the serialized handler return
 * value; `error` captures a thrown error's message. Operators should avoid
 * logging secrets — same posture as any log table.
 */
export const JOBS_SCHEMA: DatabaseSchema = {
  _job_runs: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    job_name: { type: "text", nullable: false },
    // "running" | "success" | "failed"
    status: { type: "text", nullable: false },
    started_at: { type: "text", nullable: false, default: "CURRENT_TIMESTAMP" },
    ended_at: { type: "text" },
    duration_ms: { type: "integer" },
    // log() lines + serialized return value
    output: { type: "text" },
    // failure message (status === "failed")
    error: { type: "text" },
  },
};
