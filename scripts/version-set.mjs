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

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/version-set.mjs <semver>");
  console.error("Example: node scripts/version-set.mjs 0.1.0-beta.1");
  process.exit(1);
}

/**
 * @param {string} file
 * @param {(pkg: any) => void} mutator
 */
function updateJson(file, mutator) {
  const raw = fs.readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  mutator(pkg);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}

for (const name of PUBLIC) {
  const file = path.join(REPO_ROOT, "packages", name, "package.json");
  updateJson(file, (pkg) => {
    pkg.version = version;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const dep of Object.keys(deps)) {
        if (dep.startsWith("@localbase/") && PUBLIC.includes(dep.slice("@localbase/".length))) {
          deps[dep] = version;
        }
      }
    }
  });
  console.log(`@localbase/${name} → ${version}`);
}

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

console.log("\nDone. Run npm install at the repo root if the lockfile needs refresh.");
console.log("Do not publish until pack:smoke is green.");
