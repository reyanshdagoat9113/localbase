import { Command } from "commander";
import { initCommand } from "./init.js";
import { devCommand } from "./dev.js";
import { migrateCommand, resetCommand } from "./db.js";
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
  .action(async (opts: { port: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      fail(new Error(`Invalid port: "${opts.port}". Must be between 1 and 65535.`));
    }
    try {
      await devCommand({ port });
    } catch (err) {
      fail(err);
    }
  });

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

program.parse(process.argv);
