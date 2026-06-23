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

  validatePolicies(config);
  validateBuckets(config);

  return { configPath, dbPath, dbDir, config };
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const BUCKET_NAME_RE = /^[a-z0-9-]{1,63}$/;

/**
 * Validate the optional `buckets` (storage) section of the config.
 * Failures throw {@link ConfigError} with an actionable hint so
 * misconfiguration is caught at startup.
 */
function validateBuckets(config: LocalBaseConfig): void {
  const buckets = config.buckets;
  if (buckets === undefined) return;

  if (!Array.isArray(buckets)) {
    throw new ConfigError(
      `Invalid config: "buckets" must be an array of bucket definitions.`,
      `Example: buckets: [{ name: "avatars", public: true }]`
    );
  }

  for (const bucket of buckets) {
    if (
      !bucket ||
      typeof bucket !== "object" ||
      typeof (bucket as { name?: unknown }).name !== "string"
    ) {
      throw new ConfigError(
        `Invalid config: every bucket entry must be an object with a "name" string.`,
        `Example: { name: "avatars", public: true }`
      );
    }

    const name = (bucket as { name: string }).name;
    if (!BUCKET_NAME_RE.test(name) || name.startsWith("-") || name.endsWith("-")) {
      throw new ConfigError(
        `Invalid config: bucket name "${name}" is invalid.`,
        `Bucket names must be 1-63 lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.`
      );
    }

    const public_ = (bucket as { public?: unknown }).public;
    if (public_ !== undefined && typeof public_ !== "boolean") {
      throw new ConfigError(
        `Invalid config: bucket "${name}" has a non-boolean "public" value.`,
        `Set "public: true" to make the bucket readable without authentication, or omit it for private (default).`
      );
    }
  }
}

/**
 * Validate the optional `policies` (Row-Level Security) section of the config.
 * Failures throw {@link ConfigError} with an actionable hint so misconfiguration
 * is caught at `localbase dev`/`serve` startup, not silently at request time.
 *
 * The deeper per-request enforcement (owner filtering/stamping) lives in core's
 * `createServer`; this only guards the declared shape and the auth dependency.
 */
function validatePolicies(config: LocalBaseConfig): void {
  const policies = (config as { policies?: unknown }).policies;
  if (policies === undefined) return;

  if (typeof policies !== "object" || policies === null || Array.isArray(policies)) {
    throw new ConfigError(
      `Invalid config: "policies" must be an object mapping table names to policies.`,
      `Example: policies: { projects: { ownerColumn: "owner_id" } }`
    );
  }

  if (!config.auth?.enabled) {
    throw new ConfigError(
      `Invalid config: "policies" requires auth to be enabled.`,
      `Set auth.enabled = true to use Row-Level Security.`
    );
  }

  for (const [table, policy] of Object.entries(
    policies as Record<string, unknown>
  )) {
    const tableSchema = config.tables[table];
    if (!tableSchema) {
      throw new ConfigError(
        `Invalid config: policies reference unknown table "${table}".`,
        `Add a "${table}" table to "tables", or remove the policy.`
      );
    }

    if (!policy || typeof policy !== "object") {
      throw new ConfigError(
        `Invalid config: policy for "${table}" must be an object with an "ownerColumn".`,
        `Example: ${table}: { ownerColumn: "owner_id" }`
      );
    }

    const ownerColumn = (policy as { ownerColumn?: unknown }).ownerColumn;
    if (typeof ownerColumn !== "string" || !IDENT_RE.test(ownerColumn)) {
      throw new ConfigError(
        `Invalid config: policy for "${table}" has an invalid "ownerColumn".`,
        `"ownerColumn" must be a valid column name on "${table}".`
      );
    }
    if (!(ownerColumn in tableSchema)) {
      throw new ConfigError(
        `Invalid config: policy for "${table}" references unknown column "${ownerColumn}".`,
        `Add an "${ownerColumn}" column to the "${table}" table.`
      );
    }

    const adminBypass = (policy as { adminBypass?: unknown }).adminBypass;
    if (adminBypass !== undefined && typeof adminBypass !== "boolean") {
      throw new ConfigError(
        `Invalid config: policy for "${table}" has a non-boolean "adminBypass".`,
        `"adminBypass" must be true or false (it is optional).`
      );
    }
  }
}

export { CONFIG_FILE, DB_DIR, DB_FILE };
