import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
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
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !code ||
        !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)
      ) {
        throw err;
      }

      // Playwright runs globalTeardown before it terminates webServer. Windows
      // will not unlink the SQLite files while that process still has them
      // open, so hand cleanup to a detached helper that retries after the
      // runner has shut the server down. Do not make an otherwise-green suite
      // fail solely because of teardown ordering.
      const cleanup = `
        const fs = require("node:fs");
        const target = process.argv[1];
        let attempts = 0;
        const remove = () => {
          try {
            fs.rmSync(target, { recursive: true, force: true });
            process.exit(0);
          } catch {
            if (++attempts >= 50) process.exit(0);
            setTimeout(remove, 200);
          }
        };
        remove();
      `;
      const child = spawn(process.execPath, ["-e", cleanup, DATA_DIR], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    }
  }
}
