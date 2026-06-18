import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Database, createServer as createApi, createRealtimeServer } from "@localbase/core";
import type { RealtimeServer } from "@localbase/core";
import { loadConfig, ConfigError } from "./config.js";
import { log } from "./log.js";

const DEFAULT_PORT = 5180;
/**
 * Default bind address. We default to the loopback interface because the
 * admin UI is enabled by default in `localbase dev` and, when auth is
 * disabled, the admin API is ungated — binding to `0.0.0.0` would expose
 * full admin access to anyone on the LAN. Users who want LAN access pass
 * `--host 0.0.0.0` (and, with auth disabled + admin on, `--admin-unsafe-public`).
 */
const DEFAULT_HOST = "127.0.0.1";

/** Addresses that count as "local" for the ungated-admin safety policy. */
const LOCALHOST_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

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
}

/**
 * Implements Decision #10 of the admin plan: an ungated admin API must never
 * be exposed on a public interface by accident. Returns an error message if
 * the configuration is unsafe, or `null` if it's fine.
 */
function unsafeAdminBinding(
  host: string,
  authEnabled: boolean,
  adminEnabled: boolean,
  optedInUnsafe: boolean
): string | null {
  if (authEnabled || !adminEnabled) return null; // gated, or admin off
  if (optedInUnsafe) return null; // explicit opt-in
  const isLocal = LOCALHOST_HOSTS.has(host.toLowerCase());
  if (isLocal) return null;
  return (
    `Admin UI is enabled and auth is disabled, which leaves the admin API ` +
    `UNGATED (full read/write access to every table). Refusing to bind to ` +
    `"${host}" because that would expose it beyond this machine.\n` +
    `To proceed, choose one of:\n` +
    `  • Enable auth in localbase.config.ts (recommended)\n` +
    `  • Bind to loopback: --host 127.0.0.1\n` +
    `  • Acknowledge the risk and continue: --admin-unsafe-public`
  );
}

export async function devCommand(opts: DevOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  let currentServer: ServerType | null = null;
  let currentRealtime: RealtimeServer | null = null;
  let currentDb: Database | null = null;
  let reloading = false;

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
    }

    // Create API server
    const app = createApi(db, config.tables, {
      auth: config.auth,
      admin: { enabled: true },
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
      }
    );

    // Attach realtime WebSocket server to the same HTTP server when enabled.
    const realtime =
      config.realtime?.enabled === false
        ? null
        : createRealtimeServer({
            server,
            database: db,
            config: config.realtime,
          });

    currentServer = server;
    currentRealtime = realtime;
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

      // Stop current server and close DB
      stop();

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
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      log.info("\nShutting down...");
      watcher.close();
      stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      watcher.close();
      stop();
      process.exit(0);
    });
  }

  function stop() {
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
