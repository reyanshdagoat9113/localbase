import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = ["shared", "core", "sdk", "cli"];
const VERSION = "0.1.0-beta.7";

function diagnostic(result) {
  return [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function createFixture(version = "0.1.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-release-tools-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const script of ["version-set.mjs", "publish-prerelease.mjs"]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", script), path.join(root, "scripts", script));
  }

  const manifests = {
    "packages/shared": { name: "@localbase/shared", version },
    "packages/core": {
      name: "@localbase/core",
      version,
      dependencies: { "@localbase/shared": version },
      devDependencies: { "@localbase/sdk": version },
    },
    "packages/sdk": {
      name: "@localbase/sdk",
      version,
      dependencies: { "@localbase/shared": version },
      devDependencies: { "@localbase/core": version },
    },
    "packages/cli": {
      name: "@localbase/cli",
      version,
      dependencies: { "@localbase/core": version, "@localbase/shared": version },
    },
    "packages/admin": {
      name: "@localbase/admin",
      version: "0.1.0",
      dependencies: { "@localbase/shared": version },
    },
    "examples/demo": {
      name: "demo",
      private: true,
      dependencies: { "@localbase/sdk": version },
    },
  };

  for (const [directory, manifest] of Object.entries(manifests)) {
    writeJson(path.join(root, directory, "package.json"), manifest);
  }
  writeJson(path.join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(manifests).map(([directory, manifest]) => [
        directory,
        structuredClone(manifest),
      ])
    ),
  });
  fs.mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages/cli/src/index.ts"),
    `program.version("${version}");\n`
  );
  return root;
}

test("version:set synchronizes public versions, every workspace pin, and the lockfile", () => {
  const root = createFixture();
  try {
    const result = spawnSync(process.execPath, ["scripts/version-set.mjs", VERSION], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    for (const name of PUBLIC) {
      const directory = `packages/${name}`;
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, directory, "package.json"), "utf8")
      );
      assert.equal(manifest.version, VERSION);
      assert.equal(lock.packages[directory].version, VERSION);
    }
    assert.equal(lock.packages["packages/admin"].dependencies["@localbase/shared"], VERSION);
    assert.equal(lock.packages["examples/demo"].dependencies["@localbase/sdk"], VERSION);
    assert.match(
      fs.readFileSync(path.join(root, "packages/cli/src/index.ts"), "utf8"),
      new RegExp(VERSION.replaceAll(".", "\\."))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publish:prerelease dry-runs locally; execute skips provenance off GHA", () => {
  const root = createFixture(VERSION);
  const bin = path.join(root, "bin");
  const log = path.join(root, "npm.log");
  fs.mkdirSync(bin);
  const stubScript = path.join(bin, "npm-stub.mjs");
  fs.writeFileSync(
    stubScript,
    `import fs from "node:fs";
fs.appendFileSync(process.env.NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "view") {
  console.error("npm error code E404\\n404 Not Found");
  process.exit(1);
}
`
  );
  const npmStub = path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  fs.writeFileSync(
    npmStub,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "%~dp0npm-stub.mjs" %*\r\n`
      : `#!/usr/bin/env node
import "./npm-stub.mjs";
`
  );
  fs.chmodSync(npmStub, 0o755);
  // Unset GITHUB_ACTIONS so local execute path is exercised even when tests
  // themselves run inside Actions.
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    NPM_LOG: log,
    GITHUB_ACTIONS: "",
  };

  try {
    const dryRun = spawnSync(process.execPath, ["scripts/publish-prerelease.mjs"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(dryRun.status, 0, diagnostic(dryRun));
    let calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((args) => args[0] === "publish" && args.includes("--dry-run")));

    fs.writeFileSync(log, "");
    const execute = spawnSync(
      process.execPath,
      ["scripts/publish-prerelease.mjs", "--execute"],
      { cwd: root, env, encoding: "utf8" }
    );
    assert.equal(execute.status, 0, diagnostic(execute));
    calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((args) => args[0] === "view").length, 4);
    assert.equal(calls.filter((args) => args[0] === "publish").length, 4);
    assert.ok(
      calls
        .filter((args) => args[0] === "publish")
        .every(
          (args) =>
            !args.includes("--dry-run") &&
            !args.includes("--provenance") &&
            args.includes("--tag") &&
            args.includes("beta")
        )
    );

    fs.writeFileSync(log, "");
    const withProv = spawnSync(
      process.execPath,
      ["scripts/publish-prerelease.mjs", "--execute", "--provenance"],
      { cwd: root, env, encoding: "utf8" }
    );
    assert.equal(withProv.status, 0, diagnostic(withProv));
    calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(
      calls
        .filter((args) => args[0] === "publish")
        .every((args) => args.includes("--provenance") && !args.includes("--dry-run"))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publish:prerelease rejects stable versions and non-beta tags", () => {
  const root = createFixture("0.1.0");
  try {
    const stable = spawnSync(process.execPath, ["scripts/publish-prerelease.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(stable.status, 0);
    assert.match(diagnostic(stable), /non-prerelease version/);

    const latest = spawnSync(
      process.execPath,
      ["scripts/publish-prerelease.mjs", "--tag", "latest"],
      { cwd: root, encoding: "utf8" }
    );
    assert.notEqual(latest.status, 0);
    assert.match(diagnostic(latest), /beta dist-tag/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
