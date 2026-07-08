import { existsSync, rmSync } from "node:fs";
import { DATA_DIR } from "./lib/env.js";

/**
 * Runs once after the suite. Removes ONLY the ephemeral {@link DATA_DIR} minted
 * for this run (Workstream 2.1, Gate E2E-P0). It never touches the checked-in
 * `examples/task-board/.localbase` — that directory is left entirely alone.
 *
 * When the suite is pointed at a caller-pinned `LOCALBASE_E2E_DATA_DIR`
 * (useful while debugging a flaky test against known state), we preserve it so
 * the developer can inspect what the run left behind instead of finding it
 * silently deleted.
 */
export default async function globalTeardown(): Promise<void> {
  // A pinned dir means the caller owns its lifecycle; leave it for inspection.
  if (process.env.LOCALBASE_E2E_DATA_DIR) return;

  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
}
