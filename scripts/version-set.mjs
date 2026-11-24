#!/usr/bin/env node
// @ts-check
/**
 * Workstream 3.4 — atomic version setter for the four public packages.
 *
 * Keeps @localbase/shared|core|sdk|cli on one shared version and rewrites
 * exact internal dependency pins to match.
 *
 * Usage:
 *   node scripts/version-set.mjs 0.1.0-beta.1
 *   npm run version:set -- 0.1.0-beta.1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = ["shared", "core", "sdk", "cli"];
const PUBLIC_NAMES = new Set(PUBLIC.map((name) => `@localbase/${name}`));

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/version-set.mjs <semver>");
  console.error("Example: node scripts/version-set.mjs 0.1.0-beta.1");
  process.exit(1);
}

/** @param {string} dir */
function packageJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, "package.json"))
    .filter((file) => fs.existsSync(file));
}

/** @param {any} pkg */
function updateInternalPins(pkg) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (PUBLIC_NAMES.has(dep)) {
        deps[dep] = version;
      }
    }
  }
}

const workspaceFiles = [
  ...packageJsonFiles(path.join(REPO_ROOT, "packages")),
  ...packageJsonFiles(path.join(REPO_ROOT, "examples")),
];
const manifests = new Map();

for (const file of workspaceFiles) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (PUBLIC_NAMES.has(pkg.name)) {
    pkg.version = version;
    console.log(`${pkg.name} → ${version}`);
  }
  updateInternalPins(pkg);
  manifests.set(file, pkg);
}

for (const name of PUBLIC) {
  const file = path.join(REPO_ROOT, "packages", name, "package.json");
  if (!manifests.has(file)) {
    throw new Error(`Missing public package manifest: ${file}`);
  }
}

const lockFile = path.join(REPO_ROOT, "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
for (const [file, pkg] of manifests) {
  const relativeDir = path.relative(REPO_ROOT, path.dirname(file)).split(path.sep).join("/");
  const locked = lock.packages?.[relativeDir];
  if (!locked) {
    throw new Error(`package-lock.json is missing workspace entry: ${relativeDir}`);
  }
  if (PUBLIC_NAMES.has(pkg.name)) locked.version = version;
  updateInternalPins(locked);
}

for (const [file, pkg] of manifests) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");

// Keep CLI --version string in source in sync when present as a literal.
const cliIndex = path.join(REPO_ROOT, "packages", "cli", "src", "index.ts");
if (fs.existsSync(cliIndex)) {
  let src = fs.readFileSync(cliIndex, "utf8");
  const next = src.replace(
    /\.version\(\s*["'][^"']+["']\s*\)/,
    `.version("${version}")`
  );
  if (next !== src) {
    fs.writeFileSync(cliIndex, next);
    console.log(`packages/cli/src/index.ts .version() → ${version}`);
  }
}

// Keep @localbase/shared VERSION export in sync.
const sharedIndex = path.join(REPO_ROOT, "packages", "shared", "src", "index.ts");
if (fs.existsSync(sharedIndex)) {
  const src = fs.readFileSync(sharedIndex, "utf8");
  const next = src.replace(
    /export const VERSION = ["'][^"']+["'];/,
    `export const VERSION = "${version}";`
  );
  if (next !== src) {
    fs.writeFileSync(sharedIndex, next);
    console.log(`packages/shared/src/index.ts VERSION → ${version}`);
  }
}

// Keep landing site APP_VERSION in sync.
const landingSite = path.join(REPO_ROOT, "packages", "landing", "src", "config", "site.ts");
if (fs.existsSync(landingSite)) {
  const src = fs.readFileSync(landingSite, "utf8");
  const next = src.replace(
    /export const APP_VERSION = ["'][^"']+["']/,
    `export const APP_VERSION = '${version}'`
  );
  if (next !== src) {
    fs.writeFileSync(landingSite, next);
    console.log(`packages/landing/src/config/site.ts APP_VERSION → ${version}`);
  }
}

console.log("\nDone. Public versions, workspace dependency pins, and package-lock.json are in sync.");
console.log("Do not publish until pack:smoke is green.");
