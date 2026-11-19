import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { CONFIG_FILE, DB_DIR } from "./config.js";
import { cliInvocation } from "./invocation.js";

// Auth is scaffolded ON with a stable per-project secret (not a per-process
// random one) so sessions survive restarts out of the box. The ?? env-var
// escape hatch keeps committed-config / production usage honest.
function exampleConfig(): string {
  const jwtSecret = crypto.randomBytes(32).toString("hex");
  return `export default {
  auth: {
    enabled: true,
    jwtSecret: process.env.JWT_SECRET ?? "${jwtSecret}",
    minPasswordLength: 8,
  },

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
}

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
    fs.writeFileSync(configPath, exampleConfig(), "utf-8");
    log.success(`Created ${CONFIG_FILE}`);
  } else {
    log.info(`${CONFIG_FILE} already exists`);
  }

  // Keep local data and backups out of git, creating .gitignore when missing:
  // .localbase/ and backups/ hold the database, sessions and uploaded files.
  const gitignorePath = path.resolve(cwd, ".gitignore");
  const wanted = [`${DB_DIR}/`, "backups/"];
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, wanted.join("\n") + "\n", "utf-8");
    log.success(`Created .gitignore (${wanted.join(", ")})`);
  } else {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const lines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    const missing = wanted.filter(
      (entry) => !lines.has(entry) && !lines.has(entry.replace(/\/$/, ""))
    );
    if (missing.length > 0) {
      const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(gitignorePath, prefix + missing.join("\n") + "\n", "utf-8");
      log.success(`Added ${missing.join(", ")} to .gitignore`);
    }
  }

  const cli = cliInvocation();
  log.heading("\nProject initialized! Next steps:");
  console.log(`  1. Edit ${CONFIG_FILE} to define your tables`);
  console.log(`  2. Run \`${cli} studio\` to start the server and open Admin Studio`);
  console.log(`  3. Run \`${cli} status\` any time to check your setup`);
  console.log("");
}
