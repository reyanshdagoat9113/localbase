import path from "node:path";
import fs from "node:fs";
import { createJiti } from "jiti";
import { Cron } from "croner";
import type { LocalBaseConfig } from "@localbase/shared";

const CONFIG_FILE = "localbase.config.ts";
const DB_DIR = ".localbase";
const DB_FILE = "data.db";

/**
 * Resolve the data directory for a given project cwd.
 *
 * Defaults to `<cwd>/.localbase`, matching `localbase init` and the documented
 * layout. The `LOCALBASE_DATA_DIR` environment variable overrides this for
 * tooling that needs to point the CLI at an out-of-tree database — most
 * importantly the Playwright E2E suite (Workstream 2.1), which must not
 * mutate the checked-in `examples/task-board/.localbase`, and the WS3 tarball
 * smoke tests that boot a server in a throwaway temp directory.
 *
 * The override is resolved to an absolute path so a relative value is anchored
 * to *process.cwd()* (the same anchor `localbase dev` uses), never to wherever
 * the config loader happens to be imported from.
 */
function resolveDbDir(cwd: string): string {
  const override = process.env.LOCALBASE_DATA_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.resolve(cwd, DB_DIR);
}

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
  const dbDir = resolveDbDir(cwd);
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

  if (
    config.auth !== undefined &&
    (typeof config.auth !== "object" ||
      config.auth === null ||
      Array.isArray(config.auth))
  ) {
    throw new ConfigError(
      `Invalid config: "auth" must be an object.`,
      `Example: auth: { enabled: true, jwtSecret: process.env.JWT_SECRET }`
    );
  }

  if (
    config.auth?.enabled !== undefined &&
    typeof config.auth.enabled !== "boolean"
  ) {
    throw new ConfigError(
      `Invalid config: "auth.enabled" must be a boolean.`,
      `Use auth: { enabled: false } to explicitly disable auth.`
    );
  }

  // Auth is on unless the config explicitly opts out. Applying the default
  // here (not just inside core's createServer) keeps every auth-aware code
  // path consistent: `dev`'s bind policy, `localbase auth` / `admin`
  // commands, and the Studio login flow all see the same effective config.
  // `enabled: false` in the file still wins — spread order preserves it.
  config = {
    ...config,
    auth: {
      ...config.auth,
      enabled: config.auth?.enabled ?? true,
    },
  };

  validatePolicies(config);
  validateBuckets(config);
  validateStorage(config);
  validateJobs(config);
  validateSecurity(config);

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
 * Validate the optional `storage` section of the config. Failures throw
 * {@link ConfigError} with an actionable hint so misconfiguration is caught
 * at startup rather than silently at request time.
 */
function validateStorage(config: LocalBaseConfig): void {
  const storage = config.storage;
  if (storage === undefined) return;

  if (
    typeof storage !== "object" ||
    storage === null ||
    Array.isArray(storage)
  ) {
    throw new ConfigError(
      `Invalid config: "storage" must be an object.`,
      `Example: storage: { secret: process.env.STORAGE_SECRET, maxFileSize: 10485760 }`
    );
  }

  const secret = (storage as { secret?: unknown }).secret;
  if (
    secret !== undefined &&
    (typeof secret !== "string" || secret.length === 0)
  ) {
    throw new ConfigError(
      `Invalid config: "storage.secret" must be a non-empty string.`,
      `Set it to a long random value, or omit it to fall back to auth.jwtSecret.`
    );
  }

  const maxFileSize = (storage as { maxFileSize?: unknown }).maxFileSize;
  if (
    maxFileSize !== undefined &&
    (typeof maxFileSize !== "number" ||
      !Number.isFinite(maxFileSize) ||
      maxFileSize <= 0)
  ) {
    throw new ConfigError(
      `Invalid config: "storage.maxFileSize" must be a positive number of bytes.`,
      `Example: storage: { maxFileSize: 52428800 } // 50 MiB`
    );
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

/**
 * Validate the optional `jobs` (scheduled jobs) section of the config.
 * Failures throw {@link ConfigError} with an actionable hint so a malformed
 * schedule or handler is caught at `localbase dev`/`serve` startup, not
 * silently at the first firing.
 *
 * Cron syntax is checked with `croner` (Decision #1). We additionally
 * restrict to standard 5-field cron (Decision #2): croner accepts 6/7-field
 * expressions with seconds precision, but sub-minute jobs are out of scope,
 * so those are rejected here with a clear message.
 *
 * The handler path is validated as a non-empty string only. Whether the
 * file actually exists on disk is a runtime concern (the runner imports it
 * via `jiti`), checked when a job first fires — not at config load.
 */
function validateJobs(config: LocalBaseConfig): void {
  const jobs = (config as { jobs?: unknown }).jobs;
  if (jobs === undefined) return;

  if (typeof jobs !== "object" || jobs === null || Array.isArray(jobs)) {
    throw new ConfigError(
      `Invalid config: "jobs" must be an object mapping job names to definitions.`,
      `Example: jobs: { cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" } }`
    );
  }

  for (const [name, job] of Object.entries(jobs as Record<string, unknown>)) {
    if (!name || !IDENT_RE.test(name)) {
      throw new ConfigError(
        `Invalid config: job name "${name}" is invalid.`,
        `Job names must start with a letter or underscore and contain only letters, digits, or underscores.`
      );
    }

    if (!job || typeof job !== "object") {
      throw new ConfigError(
        `Invalid config: job "${name}" must be an object with "schedule" and "handler".`,
        `Example: ${name}: { schedule: "0 3 * * *", handler: "./jobs/${name}.ts" }`
      );
    }

    const schedule = (job as { schedule?: unknown }).schedule;
    if (typeof schedule !== "string" || schedule.length === 0) {
      throw new ConfigError(
        `Invalid config: job "${name}" must have a non-empty "schedule" string.`,
        `Example: schedule: "0 3 * * *" (3 AM daily)`
      );
    }
    const cronError = validateCronSchedule(schedule);
    if (cronError) {
      throw new ConfigError(
        `Invalid config: job "${name}" schedule "${schedule}" ${cronError}`,
        `Use standard 5-field cron: "m h dom mon dow". Example: "0 3 * * *" = 3 AM daily.`
      );
    }

    const handler = (job as { handler?: unknown }).handler;
    if (typeof handler !== "string" || handler.length === 0) {
      throw new ConfigError(
        `Invalid config: job "${name}" must have a non-empty "handler" string path.`,
        `Example: handler: "./jobs/${name}.ts" (relative to project cwd)`
      );
    }

    const timezone = (job as { timezone?: unknown }).timezone;
    if (
      timezone !== undefined &&
      (typeof timezone !== "string" || !isValidTimezone(timezone))
    ) {
      throw new ConfigError(
        `Invalid config: job "${name}" has an invalid "timezone" "${timezone}".`,
        `"timezone" must be an IANA name, e.g. "America/New_York". Omit it for server-local time.`
      );
    }

    const enabled = (job as { enabled?: unknown }).enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new ConfigError(
        `Invalid config: job "${name}" has a non-boolean "enabled".`,
        `"enabled" must be true or false (it is optional; default true).`
      );
    }

    const description = (job as { description?: unknown }).description;
    if (description !== undefined && typeof description !== "string") {
      throw new ConfigError(
        `Invalid config: job "${name}" has a non-string "description".`,
        `"description" must be a free-text string (it is optional).`
      );
    }
  }
}

/**
 * Validates a cron schedule string. croner accepts 5, 6, or 7 space-separated
 * fields, but LocalBase restricts to standard 5-field cron (Decision #2), so
 * we enforce the field count before handing off to croner's parser. Returns an
 * error string on failure, or `null` when the schedule is valid.
 */
function validateCronSchedule(schedule: string): string | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `must be a standard 5-field cron expression ("m h dom mon dow"), got ${fields.length} field(s).`;
  }
  try {
    // Constructing a Cron parses + validates the pattern. We pass no function
    // so nothing executes; .stop() clears the scheduled timer immediately.
    const cron = new Cron(schedule);
    cron.stop();
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `is not a valid cron expression: ${msg}`;
  }
}

/**
 * Returns true when `tz` is a recognized IANA timezone. `Intl.DateTimeFormat`
 * throws a `RangeError` for unknown names, which we treat as invalid.
 */
function isValidTimezone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the optional `security` (HTTP-exposure hardening) section of the
 * config. Failures throw {@link ConfigError} with an actionable hint so CORS /
 * rate-limit / body-size misconfiguration is caught at `localbase dev` startup,
 * not silently at request time. This guards shape only — the deeper per-
 * request enforcement lives in core's `createServer`.
 */
function validateSecurity(config: LocalBaseConfig): void {
  const security = (config as { security?: unknown }).security;
  if (security === undefined) return;
  if (typeof security !== "object" || security === null || Array.isArray(security)) {
    throw new ConfigError(
      `Invalid config: "security" must be an object.`,
      `Example: security: { cors: { allowedOrigins: ["https://app.example.com"] } }`
    );
  }
  const s = security as Record<string, unknown>;

  const corsCfg = s.cors;
  if (corsCfg !== undefined) {
    if (
      typeof corsCfg !== "object" ||
      corsCfg === null ||
      Array.isArray(corsCfg)
    ) {
      throw new ConfigError(
        `Invalid config: "security.cors" must be an object.`,
        `Example: cors: { allowedOrigins: ["https://app.example.com"], allowCredentials: true }`
      );
    }
    const c = corsCfg as Record<string, unknown>;
    if (
      c.allowedOrigins !== undefined &&
      !Array.isArray(c.allowedOrigins)
    ) {
      throw new ConfigError(
        `Invalid config: "security.cors.allowedOrigins" must be an array of origin strings.`,
        `Example: ["https://app.example.com"]`
      );
    }
    if (Array.isArray(c.allowedOrigins)) {
      for (const o of c.allowedOrigins) {
        if (typeof o !== "string" || o.length === 0) {
          throw new ConfigError(
            `Invalid config: every entry in "security.cors.allowedOrigins" must be a non-empty string.`,
            `Example: ["https://app.example.com"]`
          );
        }
      }
    }
    if (
      c.allowCredentials !== undefined &&
      typeof c.allowCredentials !== "boolean"
    ) {
      throw new ConfigError(
        `Invalid config: "security.cors.allowCredentials" must be a boolean.`,
        `Omit it for the default (false), or set true to allow cookies/Authorization cross-origin.`
      );
    }
  }

  const rl = s.rateLimits;
  if (rl !== undefined) {
    if (typeof rl !== "object" || rl === null || Array.isArray(rl)) {
      throw new ConfigError(
        `Invalid config: "security.rateLimits" must be an object.`,
        `Example: rateLimits: { windowMs: 60000, max: 20 }`
      );
    }
    const r = rl as Record<string, unknown>;
    if (
      r.windowMs !== undefined &&
      (typeof r.windowMs !== "number" || !Number.isFinite(r.windowMs) || r.windowMs <= 0)
    ) {
      throw new ConfigError(
        `Invalid config: "security.rateLimits.windowMs" must be a positive number of milliseconds.`,
        `Example: windowMs: 60000`
      );
    }
    if (
      r.max !== undefined &&
      (typeof r.max !== "number" || !Number.isFinite(r.max) || r.max < 1)
    ) {
      throw new ConfigError(
        `Invalid config: "security.rateLimits.max" must be a positive integer.`,
        `Example: max: 20`
      );
    }
  }

  if (
    s.bodyLimitBytes !== undefined &&
    (typeof s.bodyLimitBytes !== "number" ||
      !Number.isFinite(s.bodyLimitBytes) ||
      s.bodyLimitBytes <= 0)
  ) {
    throw new ConfigError(
      `Invalid config: "security.bodyLimitBytes" must be a positive number of bytes.`,
      `Example: bodyLimitBytes: 1048576`
    );
  }

  const headers = s.headers;
  if (headers !== undefined) {
    if (
      typeof headers !== "object" ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new ConfigError(
        `Invalid config: "security.headers" must be an object.`,
        `Example: headers: { extra: { "X-Custom": "value" } }`
      );
    }
    const extra = (headers as Record<string, unknown>).extra;
    if (extra !== undefined) {
      if (typeof extra !== "object" || extra === null || Array.isArray(extra)) {
        throw new ConfigError(
          `Invalid config: "security.headers.extra" must be an object of header name -> string value.`,
          `Example: extra: { "Cross-Origin-Opener-Policy": "same-origin" }`
        );
      }
      for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new ConfigError(
            `Invalid config: "security.headers.extra" entry "${k}" must be a string.`,
            `Every extra header value must be a string.`
          );
        }
      }
    }
  }
}

export { CONFIG_FILE, DB_DIR, DB_FILE };
