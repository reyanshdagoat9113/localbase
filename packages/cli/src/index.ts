import { Command } from "commander";
import { initCommand } from "./init.js";
import { devCommand } from "./dev.js";
import { migrateCommand, resetCommand } from "./db.js";
import { log } from "./log.js";

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
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── localbase dev ──
program
  .command("dev")
  .description("Start the dev server with hot-reload")
  .action(async () => {
    try {
      await devCommand();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
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
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
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
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.parse(process.argv);
