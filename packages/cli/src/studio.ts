import { devCommand, type DevOptions } from "./dev.js";
import { log } from "./log.js";

/**
 * M6 — `localbase studio` command.
 *
 * The studio command is a thin alias for `localbase dev --open`: it
 * starts the dev server exactly the same way (same config, same
 * migrations, same hot-reload), but also opens the admin URL in the
 * user's default browser once the server is listening.
 *
 * Why a separate command instead of just `localbase dev --open`?
 *   - Discoverability — `localbase --help` lists "studio" right next
 *     to "dev", and the plan calls it out by name as a first-class
 *     entry point.
 *   - Marketing — "localbase studio" reads like a product (think
 *     `flutter studio`, `sanity studio`), which is the whole point of
 *     the M6 "platform, not dev tool" thesis.
 *   - The implementation is the same; we just hardcode `openBrowser: true`.
 *
 * All the same flags as `dev` are accepted so users can override the
 * port/host (e.g. `localbase studio --port 4000`). We also pass
 * `onReady` so the success log line is studio-branded.
 */
export interface StudioOptions extends Omit<DevOptions, "openBrowser"> {
  /** When false, skip the browser launch. Used by tests. */
  openBrowser?: boolean;
}

export async function studioCommand(
  opts: StudioOptions = {}
): Promise<void> {
  // `localbase studio` always opens the browser unless the caller
  // (typically a test) has explicitly opted out.
  const openBrowser = opts.openBrowser !== false;

  log.heading("\n📺 LocalBase Studio");
  log.info(
    "Starting dev server and opening the admin UI in your browser..."
  );

  await devCommand({
    ...opts,
    openBrowser,
  });
}
