#!/usr/bin/env node
// @ts-check
/**
 * Copy the built admin SPA bundle from `packages/admin/dist` into
 * `packages/core/dist/admin` so the published `@localbase/core` tarball
 * ships with the admin UI pre-bundled. This is the M6 build step.
 *
 * This script is a sibling of `packages/core` (run via the workspace root)
 * but is intentionally written as a self-contained ES module — it has no
 * TypeScript / tsup dependency, so it works identically inside the
 * workspace and in a clean checkout of just `@localbase/core`.
 *
 * Resolution order for the source bundle (first match wins):
 *
 *   1. `process.env.LOCALBASE_ADMIN_DIST` (explicit override)
 *   2. `<sibling>/packages/admin/dist` — the monorepo dev path
 *   3. The same dir walked up from this script — robust to npm/yarn/pnpm
 *      symlink layouts (no version of npm puts admin under node_modules
 *      of core in this repo, but we still walk up in case the script is
 *      copied out of context)
 *   4. `<core>/node_modules/@localbase/admin/dist` — installed-as-dep
 *
 * Exit codes:
 *   0 — bundle copied (or already in place)
 *   1 — unrecoverable: a source was found but the copy failed
 *   2 — `--strict` was passed and no source bundle was found
 *
 * Flags:
 *   --force     Re-copy even if `dist/admin/index.html` already exists
 *   --strict    Exit with code 2 when no source bundle is found, instead
 *               of warning. The `postbuild` step uses this to fail the
 *               publish pipeline rather than ship a core tarball without
 *               the admin UI.
 *   --quiet     Suppress the success/info log lines (used by tests).
 *
 * Why two copies (prebuild + postbuild)?
 *   tsup's `clean: true` wipes `dist/` before bundling. `prebuild` runs
 *   before tsup, so the bundle would be wiped along with everything else.
 *   We therefore (a) attempt an early copy in `prebuild` so the bundle is
 *   visible to any tooling that scans `dist/` mid-build, and (b) re-copy
 *   in `postbuild` to guarantee the final published tarball contains it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORE_PKG_DIR = path.resolve(__dirname, ".."); // packages/core
const CORE_DIST = path.join(CORE_PKG_DIR, "dist");
const TARGET = path.join(CORE_DIST, "admin");

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const STRICT = argv.includes("--strict");
const QUIET = argv.includes("--quiet");

const log = {
  info: (msg) => { if (!QUIET) console.log(`[copy-admin] ${msg}`); },
  warn: (msg) => console.warn(`[copy-admin] ${msg}`),
  error: (msg) => console.error(`[copy-admin] ${msg}`),
};

/**
 * Walk up to N levels looking for the admin dist directory. Returns the
 * first match that contains `index.html` (i.e. a real built bundle, not
 * an empty directory).
 */
function findSiblingAdminDist() {
  let dir = CORE_PKG_DIR;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "packages", "admin", "dist");
    if (isUsableBundle(candidate)) return candidate;

    // Workspace root: has a `package.json` with `name === "localbase"`.
    const rootPkg = path.join(dir, "package.json");
    if (fs.existsSync(rootPkg)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf8"));
        if (pkg.name === "localbase") break; // walked past the root
      } catch {
        // ignore malformed package.json
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isUsableBundle(dir) {
  if (!fs.existsSync(dir)) return false;
  if (!fs.existsSync(path.join(dir, "index.html"))) return false;
  // The bundle must contain the `assets/` directory emitted by Vite.
  // A directory that ONLY contains an empty `index.html` is not a real build.
  try {
    const entries = fs.readdirSync(dir);
    return entries.includes("assets");
  } catch {
    return false;
  }
}

function findSource() {
  if (process.env.LOCALBASE_ADMIN_DIST) {
    const env = process.env.LOCALBASE_ADMIN_DIST;
    if (isUsableBundle(env)) return env;
    log.warn(
      `LOCALBASE_ADMIN_DIST="${env}" is set but does not contain a built ` +
        `admin bundle (needs index.html + assets/). Ignoring.`
    );
  }

  const sibling = findSiblingAdminDist();
  if (sibling) return sibling;

  // Installed-as-dependency layout (e.g. a downstream user has
  // `@localbase/admin` listed under `dependencies`).
  const installed = path.join(
    CORE_PKG_DIR,
    "node_modules",
    "@localbase",
    "admin",
    "dist"
  );
  if (isUsableBundle(installed)) return installed;

  return null;
}

function rimraf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    } else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        copyDir(real, d);
      } else {
        fs.copyFileSync(real, d);
      }
    }
  }
}

function main() {
  const source = findSource();
  if (!source) {
    if (STRICT) {
      log.error(
        "No built admin bundle found. Build it first:\n" +
          "    npm run build --workspace @localbase/admin\n" +
          "or set LOCALBASE_ADMIN_DIST to the path of a built bundle."
      );
      process.exit(2);
    }
    log.warn(
      "No built admin bundle found. The published tarball will not " +
        "contain dist/admin/ — callers will see the M1 placeholder. " +
        "Build the admin workspace first if you want the SPA embedded."
    );
    process.exit(0);
  }

  const alreadyInPlace =
    !FORCE &&
    fs.existsSync(path.join(TARGET, "index.html")) &&
    fs.existsSync(path.join(TARGET, "assets"));

  if (alreadyInPlace) {
    log.info(`dist/admin/ already up to date (source: ${source})`);
    process.exit(0);
  }

  // Wipe and re-copy. This makes sure stale assets from a previous build
  // (e.g. removed chunks) don't leak into the tarball.
  rimraf(TARGET);
  try {
    copyDir(source, TARGET);
  } catch (err) {
    log.error(`Copy failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Sanity check: the bundle must have an index.html in the expected place.
  if (!fs.existsSync(path.join(TARGET, "index.html"))) {
    log.error(
      `Copy succeeded but dist/admin/index.html is missing. ` +
        `Source: ${source}`
    );
    process.exit(1);
  }

  // Compute size for the success log.
  const indexSize = fs.statSync(path.join(TARGET, "index.html")).size;
  const assetCount = fs
    .readdirSync(path.join(TARGET, "assets"))
    .filter((f) => !f.endsWith(".map")).length;
  log.info(
    `Copied admin bundle → dist/admin/ ` +
      `(index.html ${indexSize}B, ${assetCount} assets, source: ${source})`
  );
}

main();
