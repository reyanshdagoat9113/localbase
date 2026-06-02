import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { CONFIG_FILE, DB_DIR } from "./config.js";

const EXAMPLE_CONFIG = `export default {
  tables: {
    users: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
      email: { type: "text", unique: true },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
  },
};
`;

export function initCommand(): void {
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, CONFIG_FILE);
  const dbDir = path.resolve(cwd, DB_DIR);

  // Create .localbase/ directory
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    log.success(`Created ${DB_DIR}/ directory`);
  } else {
    log.info(`${DB_DIR}/ directory already exists`);
  }

  // Create config file
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, EXAMPLE_CONFIG, "utf-8");
    log.success(`Created ${CONFIG_FILE}`);
  } else {
    log.info(`${CONFIG_FILE} already exists`);
  }

  // Add .localbase/ to .gitignore if it exists and doesn't have it
  const gitignorePath = path.resolve(cwd, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(DB_DIR)) {
      fs.appendFileSync(gitignorePath, `\n${DB_DIR}/\n`, "utf-8");
      log.success(`Added ${DB_DIR}/ to .gitignore`);
    }
  }

  log.heading("\nProject initialized! Next steps:");
  console.log(`  1. Edit ${CONFIG_FILE} to define your tables`);
  console.log(`  2. Run ${"localbase dev"} to start the server`);
  console.log("");
}
