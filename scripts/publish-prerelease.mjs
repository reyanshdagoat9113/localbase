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
 *   node scripts/publish-prerelease.mjs --execute --provenance  # force OIDC provenance
 *   node scripts/publish-prerelease.mjs --execute --no-provenance
 *   node scripts/publish-prerelease.mjs --execute --otp 123456  # npm 2FA (auth-and-writes)
 *
 * Provenance: enabled automatically on GitHub Actions (`GITHUB_ACTIONS=true`).
 * Local publishes omit `--provenance` (npm requires a CI OIDC provider).
 * Pass `--provenance` to force it, or `--no-provenance` to skip even on GHA.
 *
 * 2FA: when the account uses auth-and-writes, pass a current authenticator
 * code via `--otp <code>` or env `NPM_OTP`. One code is reused for all four
 * packages in the run (npm accepts it for a short window).
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
const FORCE_PROVENANCE = process.argv.includes("--provenance");
const NO_PROVENANCE = process.argv.includes("--no-provenance");
const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === "true";
/** @type {boolean} */
const USE_PROVENANCE =
  EXECUTE && !NO_PROVENANCE && (FORCE_PROVENANCE || IN_GITHUB_ACTIONS);
const tagIdx = process.argv.indexOf("--tag");
const DIST_TAG = tagIdx >= 0 ? process.argv[tagIdx + 1] : "beta";
const otpIdx = process.argv.indexOf("--otp");
const OTP =
  (otpIdx >= 0 ? process.argv[otpIdx + 1] : undefined) ||
  process.env.NPM_OTP ||
  "";

if (FORCE_PROVENANCE && NO_PROVENANCE) {
  console.error("Pass only one of --provenance or --no-provenance.");
  process.exit(1);
}
if (otpIdx >= 0 && (!OTP || !/^\d{6,8}$/.test(OTP))) {
  console.error("Usage: --otp <6-8 digit code from your authenticator app>");
  process.exit(1);
}

if (!DIST_TAG || DIST_TAG !== "beta") {
  console.error("Prereleases must be published with the beta dist-tag.");
  process.exit(1);
}

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

function readPackage(name) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "packages", name, "package.json"), "utf8")
  );
}

const packages = Object.fromEntries(ORDER.map((name) => [name, readPackage(name)]));
const versions = Object.fromEntries(
  Object.entries(packages).map(([name, pkg]) => [name, pkg.version])
);
const unique = new Set(Object.values(versions));
if (unique.size !== 1) {
  console.error("Public package versions are not locked together:");
  for (const [n, v] of Object.entries(versions)) console.error(`  @localbase/${n}@${v}`);
  console.error("Run: npm run version:set -- <version>");
  process.exit(1);
}

const version = [...unique][0];
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
  console.error(`Refusing to prerelease non-prerelease version: ${version}`);
  console.error("Run: npm run version:set -- 0.1.0-beta.N");
  process.exit(1);
}

for (const [name, pkg] of Object.entries(packages)) {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dependency, dependencyVersion] of Object.entries(pkg[field] ?? {})) {
      if (
        dependency.startsWith("@localbase/") &&
        ORDER.includes(dependency.slice("@localbase/".length)) &&
        dependencyVersion !== version
      ) {
        console.error(
          `${pkg.name} has stale internal pin ${dependency}@${dependencyVersion}; expected ${version}`
        );
        console.error("Run: npm run version:set -- <version>");
        process.exit(1);
      }
    }
  }
}

console.log(`Prerelease plan: @localbase/*@${version} dist-tag=${DIST_TAG}`);
console.log(EXECUTE ? "MODE: execute (real publish)" : "MODE: dry-run (pass --execute to publish)");
if (EXECUTE) {
  console.log(
    USE_PROVENANCE
      ? "Provenance: enabled (--provenance or GitHub Actions)"
      : "Provenance: skipped (local publish; use GHA or --provenance for OIDC attestation)"
  );
  console.log(OTP ? "2FA OTP: provided" : "2FA OTP: not provided (npm may return EOTP)");
}
console.log("");

/** @type {string[]} */
const published = [];
if (EXECUTE) {
  console.log("Preflight: checking that no immutable package version already exists");
  for (const name of ORDER) {
    const pkgName = `@localbase/${name}`;
    const cwd = path.join(REPO_ROOT, "packages", name);
    const view = run("npm", ["view", `${pkgName}@${version}`, "version"], cwd);
    if (view.status === 0) {
      console.error(`${pkgName}@${version} already exists. Bump all packages and roll forward.`);
      process.exit(1);
    }
    if (!/E404|404 Not Found/i.test(view.stderr)) {
      if (view.stderr) process.stderr.write(view.stderr);
      console.error(`Could not verify registry state for ${pkgName}@${version}; aborting before publish.`);
      process.exit(view.status ?? 1);
    }
  }
  console.log("  all four versions are available");
}

for (const name of ORDER) {
  const pkgName = `@localbase/${name}`;
  const cwd = path.join(REPO_ROOT, "packages", name);
  console.log(`→ ${pkgName}@${version}`);

  const args = ["publish", "--access", "public", "--tag", DIST_TAG];
  if (!EXECUTE) args.push("--dry-run");
  else if (USE_PROVENANCE) args.push("--provenance");
  if (EXECUTE && OTP) args.push("--otp", OTP);

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
console.log(`  provenance: ${USE_PROVENANCE ? "yes" : "no"}`);
console.log(`  packages:`);
for (const p of published) console.log(`    ${p}`);
console.log(`
Next (owner steps, not automated here):
  1. Install from registry into a clean dir and re-run smoke (NPM-P0)
  2. Record checksums, commit SHA, CI run URL in the release checklist
  3. Only then create an annotated git tag / GitHub release
  4. Never promote to dist-tag "latest" until the private-beta gate
`);
