#!/usr/bin/env node
// @ts-check
/**
 * Workstream 3.4 — controlled prerelease publish in dependency order.
 *
 * Publishes the four public packages explicitly (never a blind workspace
 * publish). Stops on the first failure and reports which immutable versions
 * already exist on the registry.
 *
 * Prerequisites:
 *   - versions already set (npm run version:set -- 0.1.0-beta.N)
 *   - npm run pack:smoke green
 *   - authenticated npm user with access to @localbase
 *   - 2FA / trusted publishing configured for the scope
 *
 * Usage:
 *   node scripts/publish-prerelease.mjs              # dry-run (default)
 *   node scripts/publish-prerelease.mjs --execute     # real publish
 *   node scripts/publish-prerelease.mjs --tag beta --execute
 *
 * Never creates a git tag. Tagging/GitHub release is a separate owner step
 * after registry install smoke passes (Gate NPM-P0).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORDER = ["shared", "core", "sdk", "cli"];
const EXECUTE = process.argv.includes("--execute");
const tagIdx = process.argv.indexOf("--tag");
const DIST_TAG = tagIdx >= 0 ? process.argv[tagIdx + 1] : "beta";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 */
function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return res;
}

function readVersion(name) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "packages", name, "package.json"), "utf8")
  );
  return /** @type {string} */ (pkg.version);
}

const versions = Object.fromEntries(ORDER.map((n) => [n, readVersion(n)]));
const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Public package versions are not locked together:");
  for (const [n, v] of Object.entries(versions)) console.error(`  @localbase/${n}@${v}`);
  console.error("Run: npm run version:set -- <version>");
  process.exit(1);
}

const version = [...unique][0];
console.log(`Prerelease plan: @localbase/*@${version} dist-tag=${DIST_TAG}`);
console.log(EXECUTE ? "MODE: execute (real publish)" : "MODE: dry-run (pass --execute to publish)");
console.log("");

/** @type {string[]} */
const published = [];
/** @type {string[]} */
const skipped = [];

for (const name of ORDER) {
  const pkgName = `@localbase/${name}`;
  const cwd = path.join(REPO_ROOT, "packages", name);
  console.log(`→ ${pkgName}@${version}`);

  // Refuse to overwrite: if the exact version exists, skip (immutable).
  const view = run("npm", ["view", `${pkgName}@${version}`, "version"], cwd);
  if (view.status === 0 && view.stdout.trim() === version) {
    console.log(`  already on registry — skip (immutable)`);
    skipped.push(`${pkgName}@${version}`);
    published.push(`${pkgName}@${version}`); // treat as present for ordering report
    continue;
  }

  const args = ["publish", "--access", "public", "--tag", DIST_TAG];
  if (!EXECUTE) args.push("--dry-run");

  const res = run("npm", args, cwd);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`\nFAILED publishing ${pkgName}@${version}`);
    console.error("Already present on registry from this run / prior:");
    for (const p of published) console.error(`  ${p}`);
    console.error("Do not retag or overwrite. Fix, bump version, and roll forward.");
    process.exit(res.status ?? 1);
  }
  published.push(`${pkgName}@${version}`);
  console.log(EXECUTE ? `  published` : `  dry-run ok`);
}

console.log("\nSummary");
console.log(`  version: ${version}`);
console.log(`  tag:     ${DIST_TAG}`);
console.log(`  packages:`);
for (const p of published) console.log(`    ${p}`);
if (skipped.length) {
  console.log(`  skipped (already existed):`);
  for (const p of skipped) console.log(`    ${p}`);
}
console.log(`
Next (owner steps, not automated here):
  1. Install from registry into a clean dir and re-run smoke (NPM-P0)
  2. Record checksums, commit SHA, CI run URL in the release checklist
  3. Only then create an annotated git tag / GitHub release
  4. Never promote to dist-tag "latest" until the private-beta gate
`);
