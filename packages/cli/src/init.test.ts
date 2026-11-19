import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initCommand } from "./init.js";
import { loadConfig, CONFIG_FILE } from "./config.js";

/**
 * `localbase init` scaffolds a project that works out of the box: the
 * generated config must load cleanly and come with auth ENABLED plus a
 * stable jwtSecret (not a per-process random one), so the Admin Studio
 * login works on first boot and sessions survive restarts.
 */

let tmpRoot: string;
let prevCwd: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-init-"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
});

after(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("localbase init", () => {
  it("scaffolds a config with auth enabled and a stable secret", async () => {
    initCommand();

    const configPath = path.join(tmpRoot, CONFIG_FILE);
    assert.ok(fs.existsSync(configPath), "config file should exist");

    const raw = fs.readFileSync(configPath, "utf8");
    assert.match(raw, /enabled:\s*true/);
    // A concrete secret must be baked in — `process.env.JWT_SECRET ??` is
    // the escape hatch, not the default.
    assert.match(raw, /jwtSecret: process\.env\.JWT_SECRET \?\? "[0-9a-f]{64}"/);

    const { config } = await loadConfig(tmpRoot);
    assert.equal(config.auth?.enabled, true);
    assert.match(config.auth?.jwtSecret ?? "", /^[0-9a-f]{64}$/);
  });

  it("keeps the existing config on a second run", () => {
    const configPath = path.join(tmpRoot, CONFIG_FILE);
    const before = fs.readFileSync(configPath, "utf8");
    initCommand();
    assert.equal(fs.readFileSync(configPath, "utf8"), before);
  });

  it("generates a different secret for each project", () => {
    const firstConfig = fs.readFileSync(path.join(tmpRoot, CONFIG_FILE), "utf8");
    const firstSecret = firstConfig.match(/[0-9a-f]{64}/)?.[0];
    const secondRoot = path.join(tmpRoot, "second-project");
    fs.mkdirSync(secondRoot);

    process.chdir(secondRoot);
    try {
      initCommand();
    } finally {
      process.chdir(tmpRoot);
    }

    const secondConfig = fs.readFileSync(
      path.join(secondRoot, CONFIG_FILE),
      "utf8"
    );
    const secondSecret = secondConfig.match(/[0-9a-f]{64}/)?.[0];
    assert.ok(firstSecret);
    assert.ok(secondSecret);
    assert.notEqual(secondSecret, firstSecret);
  });

  it("creates a .gitignore for data and backups when none exists", () => {
    const gitignore = fs.readFileSync(path.join(tmpRoot, ".gitignore"), "utf8");
    assert.deepEqual(gitignore.trim().split("\n"), [".localbase/", "backups/"]);
  });

  it("appends only missing entries to an existing .gitignore", () => {
    const dir = path.join(tmpRoot, "existing-gitignore");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n.localbase\n");
    process.chdir(dir);
    try {
      initCommand();
      initCommand();
    } finally {
      process.chdir(tmpRoot);
    }
    assert.equal(
      fs.readFileSync(path.join(dir, ".gitignore"), "utf8"),
      "node_modules\n.localbase\nbackups/\n"
    );
  });
});
