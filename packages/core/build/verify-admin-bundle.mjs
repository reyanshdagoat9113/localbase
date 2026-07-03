#!/usr/bin/env node
// @ts-check
/**
 * M6 — Package verification test.
 *
 * Confirms the published `@localbase/core` artifact (the tarball that
 * `npm publish` would upload) actually contains the admin SPA bundle
 * inside `dist/admin/`. The plan calls for a *tarball* test; we run that
 * end-to-end here:
 *
 *   1. Build the admin workspace so `packages/admin/dist/` is fresh.
 *   2. Build the core workspace so `packages/core/dist/admin/` exists.
 *   3. Run `npm pack --dry-run --json` from `packages/core` to get the
 *      exact file list npm would publish.
 *   4. Assert the list contains:
 *        - dist/admin/index.html
 *        - dist/admin/assets/index-*.js
 *        - dist/admin/assets/index-*.css
 *        - dist/index.js, dist/index.cjs, dist/index.d.ts (sanity: core built)
 *
 * Why not just check the directory?
 *   Because the directory is the *source* of the tarball, not the tarball
 *   itself. `files`/`publishConfig`/ignore rules can change the actual
 *   set of files that ship. A publish-dry-run is the only way to know.
 *
 * Why not literally `npm pack` and untar?
 *   It works but is slow (full compression + a temp tarball). The dry-run
 *   JSON output gives us the exact file list without the I/O cost, and
 *   that's what `npm` uses internally to decide what to ship.
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — any check failed (build error, missing file, etc.)
 *
 * Flags:
 *   --skip-build   Reuse the existing dist/ without re-building. Useful
 *                  when running this repeatedly in a tight loop during
 *                  development. The CI runner should NOT use this flag.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CORE_DIR = path.join(REPO_ROOT, "packages", "core");
const ADMIN_DIR = path.join(REPO_ROOT, "packages", "admin");
const DIST_ADMIN = path.join(CORE_DIR, "dist", "admin");
const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes("--skip-build");

const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg) => console.error(`\x1b[31m✖\x1b[0m ${msg}`);
const info = (msg) => console.log(`  ${msg}`);

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    throw new Error(
      `Command failed (exit ${res.status}): ${cmd} ${args.join(" ")}`
    );
  }
  return res.stdout;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  console.log("M6 — package verification test for the admin SPA bundle");
  console.log("=========================================================");

  // 1. Build (unless skipped).
  if (!SKIP_BUILD) {
    console.log("\n→ Building admin + core...");
    run("npm", ["run", "build", "--workspace", "@localbase/admin"], REPO_ROOT);
    run("npm", ["run", "build", "--workspace", "@localbase/core"], REPO_ROOT);
  } else {
    console.log("\n→ Skipping build (--skip-build).");
  }

  // 2. Sanity-check the directory. The npm-pack step would catch missing
  //    files too, but checking up front gives a friendlier error message.
  if (!exists(DIST_ADMIN)) {
    fail(`dist/admin/ not found at ${DIST_ADMIN}`);
    info(
      "Run `npm run build` at the workspace root — the postbuild step in"
    );
    info("@localbase/core copies packages/admin/dist → packages/core/dist/admin.");
    process.exit(1);
  }
  if (!exists(path.join(DIST_ADMIN, "index.html"))) {
    fail(`dist/admin/index.html is missing — admin SPA was not embedded.`);
    process.exit(1);
  }
  ok("dist/admin/index.html is present");

  // 3. Inspect the dist/admin/assets/ directory.
  const assetsDir = path.join(DIST_ADMIN, "assets");
  if (!exists(assetsDir)) {
    fail("dist/admin/assets/ is missing — Vite did not emit hashed assets.");
    process.exit(1);
  }
  const assetFiles = fs.readdirSync(assetsDir);
  const jsAssets = assetFiles.filter((f) => f.endsWith(".js") && !f.endsWith(".js.map"));
  const cssAssets = assetFiles.filter((f) => f.endsWith(".css"));
  if (jsAssets.length === 0) {
    fail("dist/admin/assets/ contains no JS chunks. The React bundle is missing.");
    process.exit(1);
  }
  if (cssAssets.length === 0) {
    fail("dist/admin/assets/ contains no CSS. Tailwind output is missing.");
    process.exit(1);
  }
  ok(`dist/admin/assets/ contains ${jsAssets.length} JS + ${cssAssets.length} CSS chunks`);
  for (const f of jsAssets) info(`  ${f} (${fs.statSync(path.join(assetsDir, f)).size} B)`);
  for (const f of cssAssets) info(`  ${f} (${fs.statSync(path.join(assetsDir, f)).size} B)`);

  // 4. Sanity-check core itself.
  const coreFiles = ["index.js", "index.cjs", "index.d.ts"];
  for (const f of coreFiles) {
    if (!exists(path.join(CORE_DIR, "dist", f))) {
      fail(`packages/core/dist/${f} is missing — core build is broken.`);
      process.exit(1);
    }
  }
  ok("packages/core/dist/ contains the expected core artifacts");

  // 5. Confirm package.json `files` includes "dist" (so the tarball will
  //    actually pick up dist/admin). Without this, the .npmignore or a
  //    missing `files` entry could silently strip the SPA.
  const pkg = readJson(path.join(CORE_DIR, "package.json"));
  const filesField = pkg.files ?? [];
  if (!Array.isArray(filesField) || !filesField.includes("dist")) {
    fail(
      `packages/core/package.json "files" must include "dist" so the SPA ships. ` +
        `Found: ${JSON.stringify(filesField)}`
    );
    process.exit(1);
  }
  ok("packages/core/package.json \"files\" includes \"dist\"");

  // 6. The actual tarball test — `npm pack --dry-run --json` returns the
  //    exact list of files the published tarball would contain.
  console.log("\n→ Running `npm pack --dry-run --json` to inspect the tarball...");
  let packOutput;
  try {
    packOutput = run(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      CORE_DIR
    );
  } catch (err) {
    fail(`npm pack --dry-run failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // `npm pack --dry-run --json` shape varies by npm major. Current
  // versions emit a single JSON array whose first element has a `files`
  // array of `{ path, size, mode }` objects. Older versions emitted
  // NDJSON with a flatter shape. Handle both.
  let entries = [];
  let parsed;
  try {
    parsed = JSON.parse(packOutput);
  } catch (err) {
    // Some npm versions emit one JSON object per line (NDJSON). Parse
    // line-by-line and merge.
    for (const line of packOutput.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && Array.isArray(item.files)) {
              entries.push(...item.files);
            }
          }
        } else if (obj && Array.isArray(obj.files)) {
          entries.push(...obj.files);
        } else if (obj && typeof obj === "object" && obj.path) {
          entries.push(obj);
        }
      } catch {
        // not JSON, skip
      }
    }
  }
  if (parsed !== undefined) {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && Array.isArray(item.files)) entries.push(...item.files);
      }
    } else if (parsed && Array.isArray(parsed.files)) {
      entries = parsed.files;
    } else if (parsed && Array.isArray(parsed.entries)) {
      entries = parsed.entries;
    }
  }

  if (entries.length === 0) {
    fail(
      "Could not parse `npm pack --dry-run --json` output. " +
        "Update this test to match the npm version in use."
    );
    info("Output was:");
    info(packOutput);
    process.exit(1);
  }

  // Normalize entries — npm versions have used `path`, `files[].path`,
  // and various other shapes. We just need the string path.
  const shipped = new Set();
  for (const entry of entries) {
    if (typeof entry === "string") shipped.add(entry);
    else if (entry && typeof entry.path === "string") shipped.add(entry.path);
  }

  const required = [
    "dist/admin/index.html",
    ...jsAssets.map((f) => `dist/admin/assets/${f}`),
    ...cssAssets.map((f) => `dist/admin/assets/${f}`),
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
  ];

  const missing = required.filter((p) => !shipped.has(p));
  if (missing.length > 0) {
    fail("The tarball would not include:");
    for (const p of missing) info(`  ${p}`);
    process.exit(1);
  }
  ok(`npm pack --dry-run lists all ${required.length} expected files in the tarball`);

  // 7. Final report.
  console.log("\n=========================================================");
  console.log("\x1b[32mM6 verification passed\x1b[0m — the published @localbase/core");
  console.log("tarball will include the admin SPA at dist/admin/.");
  console.log("=========================================================");
  process.exit(0);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
