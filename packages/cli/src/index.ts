import { Command } from "commander";
import { initCommand } from "./init.js";
import { devCommand } from "./dev.js";
import { studioCommand } from "./studio.js";
import { migrateCommand, resetCommand } from "./db.js";
import {
  createUserCommand,
  listUsersCommand,
  resetPasswordCommand,
} from "./auth.js";
import { promoteCommand, demoteCommand, listAdminsCommand } from "./admin.js";
import { ConfigError } from "./config.js";
import { log } from "./log.js";

/** Pretty-prints an error and exits with code 1. */
function fail(err: unknown): never {
  if (err instanceof ConfigError) {
    log.error(err.message);
    if (err.hint) log.hint(err.hint);
  } else if (err instanceof Error) {
    log.error(err.message);
  } else {
    log.error(String(err));
  }
  process.exit(1);
}

const program = new Command();

program
  .name("localbase")
  .description("LocalBase — local-first backend platform")
  .version("0.1.0");

// ── localbase init ──
program
  .command("init")
  .description("Scaffold a new LocalBase project")
  .action(() => {
    try {
      initCommand();
    } catch (err) {
      fail(err);
    }
  });

// ── localbase dev ──
program
  .command("dev")
  .description("Start the dev server with hot-reload")
  .option(
    "-p, --port <number>",
    "Port to run the server on (default: 5180)",
    "5180"
  )
  .option(
    "-H, --host <address>",
    "Bind address (default: 127.0.0.1). Use 0.0.0.0 for LAN access.",
    "127.0.0.1"
  )
  .option(
    "--open",
    "Open the admin UI in your default browser once the server is ready",
    false
  )
  .option(
    "--admin-unsafe-public",
    "Allow an UNGATED admin API on a non-local interface when auth is disabled. " +
      "Dangerous: anyone who can reach the port has full admin access.",
    false
  )
  .action(async (opts: { port: string; host: string; open?: boolean; adminUnsafePublic?: boolean }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      fail(new Error(`Invalid port: "${opts.port}". Must be between 1 and 65535.`));
    }
    try {
      await devCommand({
        port,
        host: opts.host,
        openBrowser: opts.open === true,
        adminUnsafePublic: opts.adminUnsafePublic === true,
      });
    } catch (err) {
      fail(err);
    }
  });

// ── localbase studio ──
program
  .command("studio")
  .description(
    "Start the dev server and open the admin UI in your default browser. " +
      "Alias of `localbase dev --open` with friendlier output."
  )
  .option(
    "-p, --port <number>",
    "Port to run the server on (default: 5180)",
    "5180"
  )
  .option(
    "-H, --host <address>",
    "Bind address (default: 127.0.0.1). Use 0.0.0.0 for LAN access.",
    "127.0.0.1"
  )
  .option(
    "--no-open",
    "Don't open the admin UI in a browser (use when driving studio from a script)"
  )
  .option(
    "--admin-unsafe-public",
    "Allow an UNGATED admin API on a non-local interface when auth is disabled. " +
      "Dangerous: anyone who can reach the port has full admin access.",
    false
  )
  .action(
    async (opts: {
      port: string;
      host: string;
      open?: boolean;
      adminUnsafePublic?: boolean;
    }) => {
      const port = Number.parseInt(opts.port, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        fail(
          new Error(`Invalid port: "${opts.port}". Must be between 1 and 65535.`)
        );
      }
      try {
        await studioCommand({
          port,
          host: opts.host,
          openBrowser: opts.open !== false,
          adminUnsafePublic: opts.adminUnsafePublic === true,
        });
      } catch (err) {
        fail(err);
      }
    }
  );

// ── localbase db migrate ──
const dbCmd = program
  .command("db")
  .description("Database management commands");

dbCmd
  .command("migrate")
  .description("Run pending migrations")
  .action(async () => {
    try {
      await migrateCommand();
    } catch (err) {
      fail(err);
    }
  });

// ── localbase db reset ──
dbCmd
  .command("reset")
  .description("Drop all tables and re-run migrations")
  .action(async () => {
    try {
      await resetCommand();
    } catch (err) {
      fail(err);
    }
  });

// ── localbase auth ... ──
const authCmd = program
  .command("auth")
  .description("Authentication management (requires auth.enabled in config)");

authCmd
  .command("create-user")
  .description("Create a new user account")
  .option("-e, --email <email>", "User email (or set AUTH_EMAIL)")
  .option("-p, --password <password>", "User password (or set AUTH_PASSWORD)")
  .action(async (opts: { email?: string; password?: string }) => {
    await createUserCommand(opts);
  });

authCmd
  .command("list-users")
  .description("List all user accounts")
  .action(async () => {
    await listUsersCommand();
  });

authCmd
  .command("reset-password")
  .description("Reset a user's password")
  .option("-e, --email <email>", "User email (or set AUTH_EMAIL)")
  .option("-p, --password <password>", "New password (or set AUTH_PASSWORD)")
  .action(async (opts: { email?: string; password?: string }) => {
    await resetPasswordCommand(opts);
  });

// ── localbase admin ... ──
const adminCmd = program
  .command("admin")
  .description(
    "Admin role management (requires auth.enabled in config). The first " +
      "user to sign up is automatically an admin; these commands manage the rest."
  );

adminCmd
  .command("promote <email>")
  .description("Grant admin rights to a user")
  .action(async (email: string) => {
    await promoteCommand({ email });
  });

adminCmd
  .command("demote <email>")
  .description("Revoke admin rights from a user (refuses to demote the last admin)")
  .option("-f, --force", "Skip the confirmation prompt")
  .action(async (email: string, opts: { force?: boolean }) => {
    await demoteCommand({ email, force: opts.force === true });
  });

adminCmd
  .command("list")
  .description("List all admin users")
  .action(async () => {
    await listAdminsCommand();
  });

program.parse(process.argv);
