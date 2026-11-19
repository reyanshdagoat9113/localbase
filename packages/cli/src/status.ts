import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import pc from "picocolors";
import { Database, isDatabaseLocked } from "@localbase/core";
import type { IntrospectedSchema } from "@localbase/shared";
import { loadConfig, unprotectedTables, type ResolvedConfig } from "./config.js";
import { cliInvocation } from "./invocation.js";
import { log } from "./log.js";

const MIN_NODE_MAJOR = 22;
const DEFAULT_PORT = 5180;

export interface StatusOptions {
  /** Port to probe for a running dev server. */
  port?: number;
  /** Emit a machine-readable JSON report instead of text. */
  json?: boolean;
}

export interface SchemaDiff {
  /** Declared tables that don't exist in the database yet. */
  pendingTables: string[];
  /** Declared columns missing from existing tables (`table.column`). */
  pendingColumns: string[];
  /**
   * Columns present in the database but no longer declared (`table.column`).
   * Migrations are additive-only, so these need `db reset` to go away.
   */
  undeclaredColumns: string[];
}

export interface StatusReport {
  node: { version: string; ok: boolean };
  configPath: string;
  dataDir: string;
  database: {
    path: string;
    exists: boolean;
    sizeBytes: number | null;
    locked: boolean;
  };
  tables: { name: string; rows: number | null }[];
  schema: SchemaDiff | null;
  auth: {
    enabled: boolean;
    secretSource: "env" | "config" | "random" | null;
    users: number | null;
    unprotectedTables: string[];
  };
  jobs: number;
  buckets: number;
  server: { port: number; listening: boolean };
}

/** Compare the declared schema with what the database actually has. */
export function diffSchema(
  declared: ResolvedConfig["config"]["tables"],
  actual: IntrospectedSchema
): SchemaDiff {
  const byName = new Map(actual.tables.map((t) => [t.name, t]));
  const diff: SchemaDiff = {
    pendingTables: [],
    pendingColumns: [],
    undeclaredColumns: [],
  };
  for (const [table, columns] of Object.entries(declared)) {
    const existing = byName.get(table);
    if (!existing) {
      diff.pendingTables.push(table);
      continue;
    }
    const present = new Set(existing.columns.map((c) => c.name));
    for (const column of Object.keys(columns)) {
      if (!present.has(column)) diff.pendingColumns.push(`${table}.${column}`);
    }
    for (const column of present) {
      if (!(column in columns)) diff.undeclaredColumns.push(`${table}.${column}`);
    }
  }
  return diff;
}

function isPortListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export async function collectStatus(
  opts: StatusOptions = {},
  cwd: string = process.cwd()
): Promise<StatusReport> {
  const { configPath, dbPath, dbDir, config } = await loadConfig(cwd);
  const port = opts.port ?? DEFAULT_PORT;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const authEnabled = config.auth?.enabled === true;

  const exists = fs.existsSync(dbPath);
  let tables: StatusReport["tables"] = Object.keys(config.tables).map((name) => ({
    name,
    rows: null,
  }));
  let schema: SchemaDiff | null = null;
  let users: number | null = null;

  if (exists) {
    // Open without auto-migrating: status must never change the database.
    const db = new Database({
      path: dbPath,
      schema: config.tables,
      dataDir: dbDir,
      autoMigrate: false,
    });
    try {
      const actual = db.introspect();
      const rows = new Map(actual.tables.map((t) => [t.name, t.rowCount]));
      tables = tables.map((t) => ({ ...t, rows: rows.get(t.name) ?? null }));
      schema = diffSchema(config.tables, actual);
      users = rows.get("_users") ?? null;
    } finally {
      db.close();
    }
  }

  const jwtSecret = config.auth?.jwtSecret;
  const secretSource: StatusReport["auth"]["secretSource"] = !authEnabled
    ? null
    : !jwtSecret
      ? "random"
      : process.env.JWT_SECRET && jwtSecret === process.env.JWT_SECRET
        ? "env"
        : "config";

  return {
    node: { version: process.versions.node, ok: nodeMajor >= MIN_NODE_MAJOR },
    configPath,
    dataDir: dbDir,
    database: {
      path: dbPath,
      exists,
      sizeBytes: exists ? fs.statSync(dbPath).size : null,
      locked: exists ? isDatabaseLocked(dbPath) : false,
    },
    tables,
    schema,
    auth: {
      enabled: authEnabled,
      secretSource,
      users,
      unprotectedTables: authEnabled ? unprotectedTables(config) : [],
    },
    jobs: Object.keys(config.jobs ?? {}).length,
    buckets: (config.buckets ?? []).length,
    server: { port, listening: await isPortListening(port) },
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const report = await collectStatus(opts, cwd);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const cli = cliInvocation();
  const rel = (p: string) => path.relative(cwd, p) || ".";
  const row = (label: string, value: string) =>
    console.log(`  ${pc.dim(label.padEnd(10))} ${value}`);

  log.heading("LocalBase status");
  row("Node", report.node.ok
    ? `v${report.node.version}`
    : pc.red(`v${report.node.version} (requires >= ${MIN_NODE_MAJOR})`));
  row("Config", rel(report.configPath));
  row(
    "Database",
    report.database.exists
      ? `${rel(report.database.path)} (${formatBytes(report.database.sizeBytes ?? 0)})`
      : `${rel(report.database.path)} ${pc.dim("(not created yet)")}`
  );
  row(
    "Server",
    report.server.listening
      ? pc.green(`running on port ${report.server.port}`)
      : `not running on port ${report.server.port}`
  );
  row(
    "Auth",
    !report.auth.enabled
      ? pc.yellow("disabled")
      : `enabled${
          report.auth.secretSource === "random"
            ? pc.yellow(" (no jwtSecret: sessions reset on restart)")
            : report.auth.secretSource === "env"
              ? " (secret from JWT_SECRET)"
              : " (secret from config)"
        }${report.auth.users !== null ? `, ${report.auth.users} user(s)` : ""}`
  );
  row("Jobs", String(report.jobs));
  row("Buckets", String(report.buckets));

  console.log("");
  log.heading("Tables");
  for (const t of report.tables) {
    const pending = report.schema?.pendingTables.includes(t.name);
    console.log(
      `  ${t.name.padEnd(20)} ${
        pending || t.rows === null ? pc.yellow("pending") : `${t.rows} row(s)`
      }`
    );
  }
  console.log("");

  const problems: string[] = [];
  if (!report.node.ok) {
    log.error(`Node ${MIN_NODE_MAJOR}+ is required.`);
    problems.push("node");
  }
  if (!report.database.exists) {
    log.info(`No database yet. Run \`${cli} dev\` or \`${cli} db migrate\` to create it.`);
  } else if (report.schema) {
    const { pendingTables, pendingColumns, undeclaredColumns } = report.schema;
    if (pendingTables.length + pendingColumns.length > 0) {
      log.warn(
        `Pending migrations: ${[...pendingTables, ...pendingColumns].join(", ")}`
      );
      log.hint(`Run \`${cli} db migrate\` (or just start \`${cli} dev\`).`);
      problems.push("migrations");
    }
    if (undeclaredColumns.length > 0) {
      log.warn(
        `Columns in the database but not in your config: ${undeclaredColumns.join(", ")}`
      );
      log.hint(
        `Migrations only add columns. To drop or rename these, run \`${cli} db reset\` (deletes table data).`
      );
      problems.push("schema-drift");
    }
  }
  if (report.database.locked) {
    problems.push("locked");
    log.warn("The database is locked by another process (a running server?).");
  }
  if (report.auth.unprotectedTables.length > 0) {
    problems.push("policies");
    log.warn(
      `No policy on: ${report.auth.unprotectedTables.join(", ")} (anonymous clients can read and write).`
    );
    log.hint(`Add policies: { <table>: { ownerColumn: "user_id" } }. See https://github.com/reyanshdagoat9113/localbase/blob/main/docs/AUTH.md`);
  }
  if (problems.length === 0) {
    log.success("Everything looks good.");
  }
}
