import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * CLI admin role management tests.
 *
 * Covers `localbase admin promote <email>`, `localbase admin demote <email>`,
 * and `localbase admin list`. Each test runs against a fresh temp project
 * with auth enabled, exercising the commands through the real CLI entry
 * point (via tsx) so process.exit behaviour is isolated from the test runner.
 *
 * Note: `localbase auth create-user` always creates role=user, so these
 * tests build admin scenarios by promoting users. Owner-specific behaviour
 * (e.g. refusing to demote the owner) is covered at the API layer in
 * @localbase/core's admin-users.test.ts.
 */

let tmpRoot: string;
let repoRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-cli-admin-"));
  repoRoot = process.cwd();
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfig(dir: string, extra = ""): void {
  fs.writeFileSync(
    path.join(dir, "localbase.config.ts"),
    `export default {
  auth: { enabled: true, jwtSecret: "cli-admin-test-secret" },
  tables: {
    items: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
  ${extra}
};
`
  );
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], dir: string): RunResult {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", path.join(repoRoot, "src/index.ts"), ...args],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      }
    );
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      status: e.status ?? 1,
    };
  }
}

describe("localbase admin list", () => {
  it("reports no admins when the user table is empty", () => {
    const dir = path.join(tmpRoot, `list-empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(["admin", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No admins found/i);
  });

  it("lists a promoted admin", () => {
    const dir = path.join(tmpRoot, `list-admin-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "admin@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "admin@test.com"], dir);

    const result = run(["admin", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /admin@test\.com/);
    assert.match(result.stdout, /Admins \(1\)/);
  });

  it("lists multiple promoted admins", () => {
    const dir = path.join(tmpRoot, `list-multiple-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "admin1@test.com", "--password", "password123"], dir);
    run(["auth", "create-user", "--email", "admin2@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "admin1@test.com"], dir);
    run(["admin", "promote", "admin2@test.com"], dir);

    const result = run(["admin", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /admin1@test\.com/);
    assert.match(result.stdout, /admin2@test\.com/);
    assert.match(result.stdout, /Admins \(2\)/);
  });

  it("fails when auth is disabled", () => {
    const dir = path.join(tmpRoot, `list-noauth-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "localbase.config.ts"),
      `export default {
        tables: { items: { id: { type: "integer", primaryKey: true, autoIncrement: true }, name: { type: "text", nullable: false } } },
      };
`
    );

    const result = run(["admin", "list"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /auth is not enabled/i);
  });
});

describe("localbase admin promote", () => {
  it("promotes a regular user to admin", () => {
    const dir = path.join(tmpRoot, `promote-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "user@test.com", "--password", "password123"], dir);

    const result = run(["admin", "promote", "user@test.com"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Promoted user@test\.com/);
    assert.match(result.stdout, /1 admin/);

    const list = run(["admin", "list"], dir);
    assert.match(list.stdout, /user@test\.com/);
  });

  it("is idempotent when the user is already an admin", () => {
    const dir = path.join(tmpRoot, `promote-idempotent-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "admin@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "admin@test.com"], dir);

    const result = run(["admin", "promote", "admin@test.com"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /already an admin/i);
  });

  it("fails for an unknown email", () => {
    const dir = path.join(tmpRoot, `promote-unknown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "user@test.com", "--password", "password123"], dir);

    const result = run(["admin", "promote", "ghost@test.com"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /No user found/i);
  });

  it("requires an email argument", () => {
    const dir = path.join(tmpRoot, `promote-noarg-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(["admin", "promote"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /missing required argument|email is required/i);
  });
});

describe("localbase admin demote", () => {
  it("demotes an admin when another admin remains", () => {
    const dir = path.join(tmpRoot, `demote-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "admin1@test.com", "--password", "password123"], dir);
    run(["auth", "create-user", "--email", "admin2@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "admin1@test.com"], dir);
    run(["admin", "promote", "admin2@test.com"], dir);

    const result = run(["admin", "demote", "--force", "admin2@test.com"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Demoted admin2@test\.com/);

    const list = run(["admin", "list"], dir);
    assert.equal(list.stdout.includes("admin2@test.com"), false);
    assert.match(list.stdout, /admin1@test\.com/);
  });

  it("refuses to demote the last admin", () => {
    const dir = path.join(tmpRoot, `demote-last-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "sole@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "sole@test.com"], dir);

    const result = run(["admin", "demote", "--force", "sole@test.com"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /last admin/i);
  });

  it("fails for an unknown email", () => {
    const dir = path.join(tmpRoot, `demote-unknown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    // Two admins are required so the "last admin" guard does not mask the unknown-user path.
    run(["auth", "create-user", "--email", "admin1@test.com", "--password", "password123"], dir);
    run(["auth", "create-user", "--email", "admin2@test.com", "--password", "password123"], dir);
    run(["admin", "promote", "admin1@test.com"], dir);
    run(["admin", "promote", "admin2@test.com"], dir);

    const result = run(["admin", "demote", "--force", "ghost@test.com"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /No user found/i);
  });

  it("requires an email argument", () => {
    const dir = path.join(tmpRoot, `demote-noarg-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(["admin", "demote"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /missing required argument|email is required/i);
  });
});

describe("localbase admin command registration", () => {
  it("shows admin subcommands in --help", () => {
    const dir = path.join(tmpRoot, `help-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(["admin", "--help"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /promote/);
    assert.match(result.stdout, /demote/);
    assert.match(result.stdout, /list/);
  });
});
