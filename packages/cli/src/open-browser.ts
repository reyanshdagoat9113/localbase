import { spawn as defaultSpawn } from "node:child_process";
import process from "node:process";
import { log } from "./log.js";

type SpawnedBrowserProcess = {
  unref?: () => void;
  on?: (event: "error", listener: (err: Error) => void) => unknown;
};

type SpawnBrowser = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore" }
) => SpawnedBrowserProcess;

export interface OpenBrowserOptions {
  /** Test seam: avoids launching a real browser in unit tests. */
  spawn?: SpawnBrowser;
  /** Test seam: lets tests cover command selection without monkey-patching process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * Open a URL in the user's default browser. Pure helper, no I/O state —
 * kept separate from the rest of the CLI so it can be unit-tested
 * without a real process tree.
 *
 * Why a custom opener instead of a dependency like `open`/`open-cli`?
 *   The CLI is intentionally small and self-contained. The platform
 *   matrix is 3 commands (`open`/`start`/`xdg-open`) — easy enough to
 *   do without a dep. The `open` package also brings a transitive
 *   dependency tree (e.g. `is-wsl`) that we don't need.
 *
 * Behavior:
 *   - macOS:   `open <url>`
 *   - Windows: `cmd /c start "" <url>`  (the empty `""` is the
 *             "title" argument `start` requires)
 *   - Linux:   `xdg-open <url>`
 *   - Other / WSL: falls back to `xdg-open`, then `wslview` (best
 *     effort — logs the URL if neither is found)
 *
 * The spawned process is detached and inherits a no-op stdio so the
 * CLI's own output stays clean. We never wait for the browser to close.
 */
export interface OpenResult {
  /** True if we believe a browser invocation was issued. */
  opened: boolean;
  /**
   * The command + args we actually ran (for logging). Empty when we
   * had to fall back to logging the URL.
   */
  command: string;
  args: string[];
}

export function openBrowser(
  url: string,
  options: OpenBrowserOptions = {}
): OpenResult {
  if (!url || typeof url !== "string") {
    throw new Error("openBrowser: url is required");
  }

  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawn;

  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd builtin, not a binary. Spawn cmd.exe with /c.
    // The empty "" is the window title argument that `start` expects.
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux + WSL + everything else
    cmd = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    // Node reports common launch failures (for example ENOENT for a missing
    // opener) through the child process "error" event, not via a synchronous
    // throw. Handle it so `localbase studio` never crashes just because the
    // machine has no GUI/opener installed.
    child.on?.("error", (err) => {
      log.warn(
        `Could not open your browser automatically (${err instanceof Error ? err.message : err}).`
      );
      log.hint(`Open this URL manually: ${url}`);
    });
    // Unref so the CLI can exit independently of the browser process.
    if (typeof child.unref === "function") child.unref();
    return { opened: true, command: cmd, args };
  } catch (err) {
    log.warn(
      `Could not open your browser automatically (${err instanceof Error ? err.message : err}).`
    );
    log.hint(`Open this URL manually: ${url}`);
    return { opened: false, command: cmd, args };
  }
}

/**
 * Build the admin URL for a given dev server. Centralized so the
 * `dev`, `studio`, and any future launcher commands all agree on the
 * path. The trailing slash is significant: the SPA's router uses
 * BrowserRouter with `basename="/admin"`, and a bare `/admin` would
 * still work, but `/admin/` is what `localbase studio` advertises
 * in its success message.
 */
export function adminUrl(host: string, port: number): string {
  // Bind to a non-loopback interface → use the host as the user
  // supplied it. For loopback, always advertise `localhost` so the
  // browser opens the same thing the user would type.
  const isLoopback =
    host === "127.0.0.1" ||
    host === "::1" ||
    host.toLowerCase() === "localhost";
  const displayHost = isLoopback ? "localhost" : host;
  return `http://${displayHost}:${port}/admin/`;
}
