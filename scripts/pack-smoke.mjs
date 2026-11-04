#!/usr/bin/env node
// @ts-check
/**
 * Workstream 3.3 — Gate PACK-P0
 *
 * Build the four public packages, create real npm tarballs, install them into
 * a fresh directory (no workspace links), and exercise:
 *   - ESM + CommonJS imports
 *   - TypeScript declaration presence
 *   - CLI bin + executable bit
 *   - native deps (better-sqlite3 / argon2 via core)
 *   - embedded Admin Studio assets
 *   - localbase init (cwd-only contract)
 *   - migrate + server startup
 *   - REST CRUD, auth, realtime, Storage
 *   - graceful shutdown
 *
 * Usage:
 *   node scripts/pack-smoke.mjs
 *   node scripts/pack-smoke.mjs --skip-build   # reuse existing dist/
 *
 * Env:
 *   PACK_SMOKE_KEEP=1   keep the temp project directory for debugging
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SKIP_BUILD = process.argv.includes("--skip-build");
const KEEP = process.env.PACK_SMOKE_KEEP === "1";

/** @type {readonly string[]} */
const PUBLIC_PACKAGES = ["shared", "core", "sdk", "cli"];

const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
  process.exitCode = 1;
};
const info = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n\x1b[36m▸\x1b[0m ${msg}`);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: "pipe" | "inherit" }} [opts]
 */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: opts.stdio ?? "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    if (res.stdout) process.stderr.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    throw new Error(`Command failed (exit ${res.status}): ${cmd} ${args.join(" ")}`);
  }
  return res.stdout ?? "";
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} opts
 */
function spawnProc(cmd, args, opts) {
  return spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    // Detached so we can signal the whole process group (npx → node tree).
    detached: process.platform !== "win32",
  });
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {RegExp} pattern
 * @param {number} timeoutMs
 */
function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      buf += String(chunk);
      if (pattern.test(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(
        new Error(
          `Process exited (code ${code}) before matching ${pattern}\n--- output ---\n${buf}`
        )
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${pattern} after ${timeoutMs}ms\n--- output ---\n${buf}`
        )
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} dir
 */
function assertLicenseAndReadmeInTarballListing(dir) {
  const dry = run("npm", ["pack", "--dry-run", "--json"], { cwd: dir });
  /** @type {Array<{ files?: Array<{ path: string }> }>} */
  const parsed = JSON.parse(dry.trim());
  const files = new Set((parsed[0]?.files ?? []).map((f) => f.path));
  for (const required of ["LICENSE", "README.md"]) {
    if (![...files].some((p) => p === required || p.endsWith(`/${required}`))) {
      throw new Error(`${path.basename(dir)} tarball missing ${required}`);
    }
  }
}

async function main() {
  step("Build public packages");
  if (!SKIP_BUILD) {
    run("npm", ["run", "build"], { stdio: "inherit" });
    ok("build complete");
  } else {
    info("skipping build (--skip-build)");
  }

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-pack-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-smoke-"));
  info(`pack dir: ${packDir}`);
  info(`project:  ${projectDir}`);

  /** @type {Record<string, string>} */
  const tarballs = {};

  try {
    step("Create tarballs (dependency order)");
    for (const name of PUBLIC_PACKAGES) {
      const pkgDir = path.join(REPO_ROOT, "packages", name);
      assertLicenseAndReadmeInTarballListing(pkgDir);
      const out = run("npm", ["pack", "--pack-destination", packDir], {
        cwd: pkgDir,
      });
      const filename = out.trim().split("\n").filter(Boolean).pop();
      if (!filename) throw new Error(`npm pack produced no filename for ${name}`);
      const full = path.join(packDir, path.basename(filename));
      if (!fs.existsSync(full)) {
        throw new Error(`Expected tarball missing: ${full}`);
      }
      tarballs[name] = full;
      ok(`packed @localbase/${name} → ${path.basename(full)}`);
    }

    step("Scaffold clean consumer project");
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "localbase-pack-smoke",
          private: true,
          type: "module",
          engines: { node: ">=22" },
        },
        null,
        2
      )
    );

    // Install in dependency order so npm resolves local file: deps cleanly.
    const installOrder = [
      tarballs.shared,
      tarballs.core,
      tarballs.sdk,
      tarballs.cli,
    ];
    run("npm", ["install", ...installOrder], {
      cwd: projectDir,
      stdio: "inherit",
    });
    ok("installed tarballs into clean project");

    step("Verify package layout (LICENSE, README, types, admin assets, CLI bin)");
    const nm = path.join(projectDir, "node_modules", "@localbase");
    for (const name of PUBLIC_PACKAGES) {
      const root = path.join(nm, name);
      for (const f of ["LICENSE", "README.md", "package.json"]) {
        if (!fs.existsSync(path.join(root, f))) {
          throw new Error(`Missing ${f} in installed @localbase/${name}`);
        }
      }
      for (const f of ["dist/index.js", "dist/index.cjs", "dist/index.d.ts"]) {
        if (!fs.existsSync(path.join(root, f))) {
          throw new Error(`Missing ${f} in installed @localbase/${name}`);
        }
      }
      ok(`@localbase/${name} files present`);
    }

    const adminIndex = path.join(nm, "core", "dist", "admin", "index.html");
    if (!fs.existsSync(adminIndex)) {
      throw new Error("Embedded Admin Studio missing: dist/admin/index.html");
    }
    ok("embedded Admin Studio assets present");

    const cliBin = path.join(nm, "cli", "dist", "index.js");
    const st = fs.statSync(cliBin);
    // On Unix, npm pack preserves the shebang file; executable bit should be set
    // after install for the bin link.
    const binLink = path.join(projectDir, "node_modules", ".bin", "localbase");
    if (!fs.existsSync(binLink)) {
      throw new Error("CLI bin link missing: node_modules/.bin/localbase");
    }
    if (process.platform !== "win32") {
      const mode = fs.statSync(binLink).mode;
      if ((mode & 0o111) === 0) {
        throw new Error("CLI bin is not executable");
      }
    }
    ok(`CLI bin ready (${cliBin}, size ${st.size})`);

    step("ESM + CommonJS imports");
    const esmProbe = path.join(projectDir, "probe-esm.mjs");
    fs.writeFileSync(
      esmProbe,
      `
import { VERSION } from "@localbase/shared";
import { Database, createServer } from "@localbase/core";
import { createClient } from "@localbase/sdk";
if (typeof VERSION !== "string") throw new Error("VERSION missing");
if (typeof Database !== "function") throw new Error("Database missing");
if (typeof createServer !== "function") throw new Error("createServer missing");
if (typeof createClient !== "function") throw new Error("createClient missing");
console.log("esm-ok", VERSION);
`
    );
    const esmOut = run("node", [esmProbe], { cwd: projectDir });
    if (!esmOut.includes("esm-ok")) throw new Error("ESM probe failed");
    ok(`ESM imports (${esmOut.trim()})`);

    const cjsProbe = path.join(projectDir, "probe-cjs.cjs");
    fs.writeFileSync(
      cjsProbe,
      `
const shared = require("@localbase/shared");
const core = require("@localbase/core");
const sdk = require("@localbase/sdk");
if (typeof shared.VERSION !== "string") throw new Error("VERSION missing");
if (typeof core.Database !== "function") throw new Error("Database missing");
if (typeof sdk.createClient !== "function") throw new Error("createClient missing");
console.log("cjs-ok", shared.VERSION);
`
    );
    const cjsOut = run("node", [cjsProbe], { cwd: projectDir });
    if (!cjsOut.includes("cjs-ok")) throw new Error("CJS probe failed");
    ok(`CJS imports (${cjsOut.trim()})`);

    step("CLI: init (cwd-only contract)");
    // Documented contract: init scaffolds the current directory only.
    const help = run("npx", ["localbase", "init", "--help"], { cwd: projectDir });
    if (/\[directory\]|<directory>|\[path\]/.test(help)) {
      throw new Error(
        "CLI advertises init <directory>, but only cwd init is supported"
      );
    }
    run("npx", ["localbase", "init"], { cwd: projectDir, stdio: "inherit" });
    if (!fs.existsSync(path.join(projectDir, "localbase.config.ts"))) {
      throw new Error("init did not create localbase.config.ts");
    }
    if (!fs.existsSync(path.join(projectDir, ".localbase"))) {
      throw new Error("init did not create .localbase/");
    }
    ok("localbase init created config + .localbase/");

    // Overwrite with a smoke-friendly config: auth + public table + storage bucket.
    fs.writeFileSync(
      path.join(projectDir, "localbase.config.ts"),
      `export default {
  auth: {
    enabled: true,
    jwtSecret: "pack-smoke-secret-do-not-use-in-prod",
    accessTokenExpiry: "1h",
    refreshTokenExpiry: 60 * 60,
    minPasswordLength: 6,
  },
  tables: {
    notes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      body: { type: "text" },
    },
  },
  buckets: [
    { name: "smoke-files", public: false },
  ],
};
`
    );
    ok("wrote smoke localbase.config.ts (auth + storage)");

    step("CLI: db migrate");
    run("npx", ["localbase", "db", "migrate"], {
      cwd: projectDir,
      stdio: "inherit",
    });
    ok("migrations applied");

    step("CLI: start dev server + exercise API surface");
    const port = 5199;
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawnProc(
      "npx",
      ["localbase", "dev", "--port", String(port), "--host", "127.0.0.1"],
      { cwd: projectDir }
    );
    let serverLog = "";
    child.stdout?.on("data", (c) => {
      serverLog += String(c);
    });
    child.stderr?.on("data", (c) => {
      serverLog += String(c);
    });

    try {
      await waitForOutput(
        child,
        /localhost|127\.0\.0\.1|listening|ready|http:\/\//i,
        60_000
      );
      // Give native bind a moment after the log line.
      await sleep(500);
      ok(`dev server up on ${baseUrl}`);

      // Health / REST via fetch
      const listEmpty = await fetch(`${baseUrl}/api/notes`);
      if (!listEmpty.ok) {
        throw new Error(`GET /api/notes failed: ${listEmpty.status}`);
      }
      ok("REST GET ok");

      const created = await fetch(`${baseUrl}/api/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "smoke", body: "hello" }),
      });
      const createdJson = await created.json();
      if (!created.ok) {
        throw new Error(`POST /api/notes failed: ${JSON.stringify(createdJson)}`);
      }
      const noteId = createdJson.data?.id ?? createdJson.id;
      if (noteId == null) {
        throw new Error(`POST response missing id: ${JSON.stringify(createdJson)}`);
      }
      ok(`REST POST created note id=${noteId}`);

      // Auth via SDK (sign up + sign in) + Storage
      const authScript = path.join(projectDir, "smoke-auth.mjs");
      fs.writeFileSync(
        authScript,
        `
import { createClient } from "@localbase/sdk";
const db = createClient(${JSON.stringify(baseUrl)});
const email = "smoke-" + Date.now() + "@example.com";
const password = "secret12";
const up = await db.auth.signUp({ email, password });
if (up.error) throw new Error("signUp: " + up.error);
if (!up.data?.accessToken) throw new Error("signUp missing accessToken");
const inn = await db.auth.signIn({ email, password });
if (inn.error) throw new Error("signIn: " + inn.error);
if (!inn.data?.accessToken) throw new Error("signIn missing accessToken");
if (!db.auth.getSession()?.accessToken) throw new Error("session not stored");
const blob = new Blob([Buffer.from("pack-smoke-bytes")], { type: "text/plain" });
const file = new File([blob], "hello.txt", { type: "text/plain" });
const upl = await db.storage.from("smoke-files").upload(file, "hello.txt");
if (upl.error) throw new Error("storage upload: " + upl.error);
const listed = await db.storage.from("smoke-files").list();
if (listed.error) throw new Error("storage list: " + listed.error);
console.log("auth-storage-ok");
`
      );
      const authOut = run("node", [authScript], { cwd: projectDir });
      if (!authOut.includes("auth-storage-ok")) {
        throw new Error("auth/storage smoke failed: " + authOut);
      }
      ok("auth signUp/signIn + Storage upload/list");

      // Realtime: auth handshake required when auth is enabled, then subscribe + insert
      const rtScript = path.join(projectDir, "smoke-realtime.mjs");
      fs.writeFileSync(
        rtScript,
        `
import { createClient } from "@localbase/sdk";
const db = createClient(${JSON.stringify(baseUrl)});
const email = "rt-" + Date.now() + "@example.com";
const password = "secret12";
const up = await db.auth.signUp({ email, password });
if (up.error) throw new Error("rt signUp: " + up.error);
const events = [];
const unsub = db.subscribe("notes", (ev) => events.push(ev));
// Wait for WS connect + auth:ok + subscribe flush
await new Promise((r) => setTimeout(r, 800));
const res = await fetch(${JSON.stringify(baseUrl + "/api/notes")}, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "rt", body: "event" }),
});
if (!res.ok) throw new Error("insert for realtime failed: " + res.status);
for (let i = 0; i < 20 && events.length < 1; i++) {
  await new Promise((r) => setTimeout(r, 100));
}
unsub();
db.close();
if (events.length < 1) throw new Error("no realtime events received");
const e = events[0];
if (e.type !== "insert" || e.table !== "notes") {
  throw new Error("unexpected event: " + JSON.stringify(e));
}
console.log("realtime-ok", events.length);
`
      );
      const rtOut = run("node", [rtScript], { cwd: projectDir });
      if (!rtOut.includes("realtime-ok")) {
        throw new Error("realtime smoke failed: " + rtOut);
      }
      ok(`realtime subscription (${rtOut.trim()})`);

      // Admin SPA served
      const adminRes = await fetch(`${baseUrl}/admin/`);
      if (!adminRes.ok) {
        throw new Error(`Admin Studio HTTP ${adminRes.status}`);
      }
      const adminHtml = await adminRes.text();
      if (!adminHtml.includes("<") || adminHtml.length < 50) {
        throw new Error("Admin Studio response looks empty");
      }
      ok("Admin Studio served at /admin/");
    } finally {
      step("Graceful shutdown");
      if (child.pid && !child.killed) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          sleep(5_000),
        ]);
        if (!child.killed && child.exitCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          await sleep(200);
        }
      }
      ok("dev server stopped");
    }

    if (process.exitCode && process.exitCode !== 0) {
      throw new Error("smoke suite recorded failures");
    }

    console.log("\n\x1b[32mPACK-P0 smoke suite passed\x1b[0m");
  } finally {
    if (KEEP) {
      info(`PACK_SMOKE_KEEP=1 — leaving ${projectDir} and ${packDir}`);
    } else {
      // Best-effort: Windows can briefly hold SQLite/pack files after shutdown (EPERM).
      for (const dir of [projectDir, packDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
          info(`could not remove ${dir}: ${err.code ?? err}`);
        }
      }
    }
  }
}

main()
  .then(() => {
    // Force exit: npm/npx child process trees can leave open handles.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
