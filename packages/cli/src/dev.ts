import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import {
  Database,
  Scheduler,
  createServer as createApi,
  createRealtimeServer,
  resolveAuthConfig,
  resolvePolicies,
} from "@localbase/core";
import type { RealtimeServer } from "@localbase/core";
import { loadConfig, ConfigError, unprotectedTables } from "./config.js";
import { log } from "./log.js";
import { unsafeAdminBinding } from "./admin-bind-policy.js";
import { adminUrl, openBrowser } from "./open-browser.js";

const DEFAULT_PORT = 5180;
/**
 * Default bind address. We default to the loopback interface because the
 * admin UI is enabled by default in `localbase dev` and, when auth is
 * disabled, the admin API is ungated — binding to `0.0.0.0` would expose
 * full admin access to anyone on the LAN. Users who want LAN access pass
 * `--host 0.0.0.0` (and, with auth disabled + admin on, `--admin-unsafe-public`).
 */
const DEFAULT_HOST = "127.0.0.1";

export interface DevOptions {
  port?: number;
  /** Bind address. Defaults to `127.0.0.1` for safety (see DEFAULT_HOST). */
  host?: string;
  /**
   * Explicit opt-in to expose an ungated admin API on a non-local interface.
   * Only meaningful when auth is disabled and admin is enabled. Without it,
   * that combination on a public `--host` is a hard startup error.
   */
  adminUnsafePublic?: boolean;
  /**
   * Open the admin UI in the default browser after the server is ready.
   * Used by `localbase studio` and `--open` on the dev command. The
   * browser is opened exactly once per `devCommand` invocation — a
   * config-file hot-reload does not re-open it.
   */
  openBrowser?: boolean;
  /**
   * Optional callback fired after the server is bound and listening.
   * Receives the resolved host/port so callers (e.g. tests) can hit the
   * server without re-implementing port discovery. Runs *after* the
   * success log lines and *before* `openBrowser` if both are set.
   */
  onReady?: (info: { host: string; port: number }) => void | Promise<void>;
}

export async function devCommand(opts: DevOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  let currentServer: ServerType | null = null;
  let currentRealtime: RealtimeServer | null = null;
  let currentScheduler: Scheduler | null = null;
  let currentDb: Database | null = null;
  let reloading = false;
  let didOpenBrowser = false;

  async function start() {
    const cwd = process.cwd();
    const { configPath, dbPath, dbDir, config } = await loadConfig(cwd);

    // ── Admin exposure safety (Decision #10/#11) ──
    // `localbase dev` always enables the admin UI. When auth is also disabled,
    // the admin API is ungated. Refuse to bind that to a non-local interface
    // unless the user explicitly opts in with --admin-unsafe-public.
    const adminEnabled = true; // dev always mounts admin
    const authEnabled = config.auth?.enabled === true;
    const unsafe = unsafeAdminBinding(
      host,
      authEnabled,
      adminEnabled,
      opts.adminUnsafePublic === true
    );
    if (unsafe) {
      throw new ConfigError(unsafe);
    }

    // Ensure .localbase/ directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Create database and run migrations
    const db = new Database({
      path: dbPath,
      schema: config.tables,
      auth: config.auth,
      dataDir: dbDir,
      buckets: config.buckets,
      jobs: config.jobs,
    });
    const applied = db.getAppliedMigrations();
    log.info(`Database: ${path.relative(cwd, dbPath)}`);
    log.info(`Tables: ${[...applied].join(", ")}`);
    if (config.auth?.enabled) {
      log.info(
        `Auth: enabled${
          config.auth.jwtSecret
            ? ""
            : " (random secret — sessions reset on restart)"
        }`
      );
      // Auth alone does not protect table data: without an owner policy a
      // table's REST endpoints accept anonymous reads and writes. Say so
      // explicitly, since "auth enabled" reads like "tables are protected".
      const unprotected = unprotectedTables(config);
      if (unprotected.length > 0) {
        log.warn(
          `No policy on: ${unprotected.join(", ")} — anyone who can reach the API can read and write ${
            unprotected.length === 1 ? "this table" : "these tables"
          }.`
        );
        log.hint(
          `Add policies: { <table>: { ownerColumn: "user_id" } } to scope rows to the signed-in user. See https://github.com/reyanshdagoat9113/localbase/blob/main/docs/AUTH.md`
        );
      }
    }

    // Construct the process-owned scheduler before the API so the admin
    // router can share the same registry/runner used by cron callbacks.
    const jobsMap = config.jobs ?? {};
    const hasJobs = Object.keys(jobsMap).length > 0;
    // Keep an inert scheduler even for an empty registry so the admin Jobs
    // endpoint can return `[]` and render its setup guidance instead of 404.
    const scheduler = new Scheduler({ db, cwd, jobs: jobsMap });

    // Create API server
    const app = createApi(db, config.tables, {
      auth: config.auth,
      admin: { enabled: true },
      policies: config.policies,
      storage: config.storage,
      security: config.security,
      scheduler,
    });

    // Start HTTP server
    const server = serve(
      {
        fetch: app.fetch,
        hostname: host,
        port,
      },
      (info) => {
        log.success(`Server running at http://localhost:${info.port}`);
        log.success(`Admin UI at http://localhost:${info.port}/admin`);
        if (config.realtime?.enabled !== false) {
          log.success(`Realtime WS at ws://localhost:${info.port}${config.realtime?.path ?? "/realtime"}`);
        }
        log.info("Press Ctrl+C to stop");

        // Fire the onReady hook before the optional browser launch so
        // callers (e.g. integration tests) can race the browser open.
        if (opts.onReady) {
          try {
            const result = opts.onReady({ host, port: info.port });
            if (result && typeof (result as Promise<void>).then === "function") {
              (result as Promise<void>).catch((err) => {
                log.warn(
                  `onReady callback rejected: ${err instanceof Error ? err.message : err}`
                );
              });
            }
          } catch (err) {
            log.warn(
              `onReady callback threw: ${err instanceof Error ? err.message : err}`
            );
          }
        }

        if (opts.openBrowser === true && !didOpenBrowser) {
          didOpenBrowser = true;
          const url = adminUrl(host, info.port);
          const result = openBrowser(url);
          if (result.opened) {
            log.success(`Opening ${url} in your browser...`);
          }
        }
      }
    );

    // Attach realtime WebSocket server to the same HTTP server when enabled.
    //
    // Security wiring (Workstream 1.1): when auth is enabled the realtime
    // handshake authenticates the access token (sent as an initial message, not
    // in the URL), and any owner-protected policies are enforced on every
    // subscription and replayed event — mirroring the REST RLS path. Resolving
    // the secret + policy map here (rather than inside `createServer`) keeps
    // the realtime server's authz source-of-truth explicit and lets the startup
    // guard inside `createRealtimeServer` refuse an unprotected socket.
    const realtime =
      config.realtime?.enabled === false
        ? null
        : createRealtimeServer({
            server,
            database: db,
            config: config.realtime,
            authSecret: authEnabled
              ? resolveAuthConfig(config.auth!).config.jwtSecret
              : undefined,
            policies: config.policies
              ? resolvePolicies(config.policies, config.tables)
              : undefined,
          });

    // Arm the scheduled-jobs scheduler when any jobs are declared. Like the
    // realtime server, the scheduler is a long-running process (timers), not
    // part of the HTTP router — so it lives here in `dev`, next to realtime,
    // and is torn down + re-armed on config hot-reload. No-op when `jobs` is
    // empty/absent (Decision #7).
    if (hasJobs) {
      scheduler.start();
      const armed = Object.entries(jobsMap)
        .filter(([, j]) => j.enabled !== false)
        .map(([n]) => n);
      const paused = Object.entries(jobsMap)
        .filter(([, j]) => j.enabled === false)
        .map(([n]) => n);
      log.info(
        `Jobs: ${armed.length} armed${
          paused.length > 0 ? `, ${paused.length} paused` : ""
        }` + (armed.length > 0 ? ` (${armed.join(", ")})` : "")
      );
    }

    currentServer = server;
    currentRealtime = realtime;
    currentScheduler = scheduler;
    currentDb = db;

    // Watch config file for changes
    const configDir = path.dirname(configPath);
    const configName = path.basename(configPath);

    log.info(`Watching ${path.relative(cwd, configPath)} for changes...`);

    const watcher = fs.watch(configDir, (eventType, filename) => {
      if (filename !== configName) return;
      if (reloading) return;

      reloading = true;
      log.info("Config changed, reloading...");

      void (async () => {
        // Stop current server, drain in-flight jobs, then close DB before
        // reloading. The drain is important because Scheduler.stop() only
        // prevents future firings; active handlers still need the DB to
        // finalize their `_job_runs` rows.
        await stop();

        // Small delay to let file write complete
        setTimeout(async () => {
          try {
            await start();
            reloading = false;
          } catch (err) {
            if (err instanceof ConfigError) {
              log.error(`Reload failed: ${err.message}`);
              if (err.hint) log.hint(err.hint);
            } else {
              log.error(`Reload failed: ${err instanceof Error ? err.message : err}`);
            }
            log.info("Fix the config and save again to retry.");
            reloading = false;
          }
        }, 100);
      })();
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      void (async () => {
        log.info("\nShutting down...");
        watcher.close();
        await stop();
        process.exit(0);
      })();
    });

    process.on("SIGTERM", () => {
      void (async () => {
        watcher.close();
        await stop();
        process.exit(0);
      })();
    });
  }

  async function stop() {
    // Tear down timers first so no new firing can race with the DB close, then
    // wait for already-started handlers to finish before closing the DB they
    // need to finalize `_job_runs` rows.
    if (currentScheduler) {
      const scheduler = currentScheduler;
      currentScheduler = null;
      scheduler.stop();
      await scheduler.waitForIdle();
    }
    if (currentRealtime) {
      currentRealtime.close();
      currentRealtime = null;
    }
    if (currentServer) {
      currentServer.close();
      currentServer = null;
    }
    if (currentDb) {
      currentDb.close();
      currentDb = null;
    }
  }

  try {
    await start();
  } catch (err) {
    // Re-throw so the top-level handler in index.ts can format + add hint
    throw err;
  }
}
