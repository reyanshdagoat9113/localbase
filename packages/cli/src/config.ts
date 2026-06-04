import path from "node:path";
import fs from "node:fs";
import { createJiti } from "jiti";
import type { LocalBaseConfig } from "@localbase/shared";

const CONFIG_FILE = "localbase.config.ts";
const DB_DIR = ".localbase";
const DB_FILE = "data.db";

export interface ResolvedConfig {
  /** Absolute path to the config file */
  configPath: string;
  /** Absolute path to the database file */
  dbPath: string;
  /** Absolute path to the .localbase directory */
  dbDir: string;
  /** The parsed config */
  config: LocalBaseConfig;
}

/**
 * Custom error for config-related issues, with hints for the user.
 */
export class ConfigError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/**
 * Loads the localbase config from the project directory.
 * Uses jiti to support TypeScript config files.
 */
export async function loadConfig(
  cwd: string = process.cwd()
): Promise<ResolvedConfig> {
  const configPath = path.resolve(cwd, CONFIG_FILE);
  const dbDir = path.resolve(cwd, DB_DIR);
  const dbPath = path.resolve(dbDir, DB_FILE);

  // Check file exists first for a cleaner error than jiti's default
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `No ${CONFIG_FILE} found in ${cwd}`,
      `Run \`localbase init\` to create one.`
    );
  }

  const jiti = createJiti(cwd, {
    interopDefault: true,
  });

  let config: LocalBaseConfig;
  try {
    const imported = await jiti.import(configPath);
    // jiti may wrap the default export — unwrap if needed
    config = (
      imported && typeof imported === "object" && "default" in imported
        ? (imported as { default: LocalBaseConfig }).default
        : imported
    ) as LocalBaseConfig;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config from ${configPath}:\n${message}`);
  }

  // Validate config shape
  if (!config || typeof config !== "object" || !("tables" in config)) {
    throw new ConfigError(
      `Invalid config: must export an object with a "tables" property.`,
      `Example: export default { tables: { ... } }`
    );
  }

  if (typeof config.tables !== "object" || config.tables === null) {
    throw new ConfigError(
      `Invalid config: "tables" must be an object.`
    );
  }

  return { configPath, dbPath, dbDir, config };
}

export { CONFIG_FILE, DB_DIR, DB_FILE };
