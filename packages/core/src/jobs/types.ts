import type { Database } from "../db.js";

/**
 * Context handed to every job handler. This is the entire surface a job
 * sees — handlers are deliberately server-side system code with no access
 * to the HTTP request layer.
 *
 * - `db` is the live {@link Database} instance. Writes go through the same
 *   class realtime/admin use, so they emit `change` events (the dashboard
 *   live-updates for free). `db` bypasses HTTP-layer RLS **by design**:
 *   a nightly session-cleanup job is not a user request and must touch
 *   rows regardless of owner. Document this loudly so developers do not
 *   expect `ownerColumn` stamping inside jobs.
 * - `log(line)` appends a line to the run's recorded `output`.
 * - `name` is the job's registered key from the `jobs` config map.
 */
export interface JobContext {
  /** Live Database instance. Full access; bypasses HTTP-layer RLS by design. */
  db: Database;
  /** Append a line to this run's `output`. */
  log: (line: string) => void;
  /** The job's registered name (key from the `jobs` config map). */
  name: string;
}

/**
 * The contract a job handler file default-exports. A handler receives the
 * {@link JobContext} and may return a value (or a Promise of one); if the
 * resolved value is not `undefined`, it is JSON-serialized and appended to
 * the run's `output` alongside any `log()` lines.
 *
 * A thrown error (sync or async) sets the run's `status` to `"failed"` and
 * records the message in `error`.
 */
export type JobHandler = (ctx: JobContext) => unknown | Promise<unknown>;
