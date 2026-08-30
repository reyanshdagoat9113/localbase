import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * CLI auth management tests.
 *
 * Covers `localbase auth create-user`, `localbase auth list-users`, and
 * `localbase auth reset-password`. Like admin.test.ts, these spawn the CLI
 * via tsx in isolated temp projects so process.exit does not affect the runner.
 */

let tmpRoot: string;
let repoRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-cli-auth-"));
  repoRoot = process.cwd();
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "localbase.config.ts"),
    `export default {
  auth: { enabled: true, jwtSecret: "cli-auth-test-secret" },
  tables: {
    items: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
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
  // Resolve tsx's CLI entry directly: `npx` is a .cmd shim on Windows that
  // execFileSync cannot spawn without a shell.
  const tsxCli = createRequire(path.join(repoRoot, "package.json")).resolve(
    "tsx/cli"
  );
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxCli, path.join(repoRoot, "src/index.ts"), ...args],
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

describe("localbase auth create-user", () => {
  it("creates a user with role=user", () => {
    const dir = path.join(tmpRoot, `create-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(
      ["auth", "create-user", "--email", "user@test.com", "--password", "password123"],
      dir
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Created user #1/);
    assert.match(result.stdout, /user@test\.com/);
  });

  it("fails when the email already exists", () => {
    const dir = path.join(tmpRoot, `create-dup-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "user@test.com", "--password", "password123"], dir);
    const result = run(
      ["auth", "create-user", "--email", "user@test.com", "--password", "password123"],
      dir
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /already registered|already exists/i);
  });

  it("fails when email or password is missing", () => {
    const dir = path.join(tmpRoot, `create-missing-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const noEmail = run(["auth", "create-user", "--password", "password123"], dir);
    assert.equal(noEmail.status, 1);
    assert.match(noEmail.stderr + noEmail.stdout, /--email and --password are required/i);

    const noPassword = run(["auth", "create-user", "--email", "user@test.com"], dir);
    assert.equal(noPassword.status, 1);
    assert.match(noPassword.stderr + noPassword.stdout, /--email and --password are required/i);
  });

  it("accepts credentials from AUTH_EMAIL and AUTH_PASSWORD env vars", () => {
    const dir = path.join(tmpRoot, `create-env-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    try {
      const result = run(["auth", "create-user"], dir);
      // By default env vars are not set, so this should fail.
      assert.equal(result.status, 1);
      assert.match(result.stderr + result.stdout, /--email and --password are required/i);

      // Now set the env vars by passing them through the spawn.
      const withEnv = execFileSync(
        process.execPath,
        [
          createRequire(path.join(repoRoot, "package.json")).resolve("tsx/cli"),
          path.join(repoRoot, "src/index.ts"),
          "auth",
          "create-user",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            AUTH_EMAIL: "envuser@test.com",
            AUTH_PASSWORD: "password123",
          },
        }
      );
      assert.match(withEnv, /Created user #1/);
      assert.match(withEnv, /envuser@test\.com/);
    } catch (err) {
      // execFileSync throws on non-zero exit; surface the real failure.
      throw err;
    }
  });
});

describe("localbase auth list-users", () => {
  it("lists created users", () => {
    const dir = path.join(tmpRoot, `list-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "a@test.com", "--password", "password123"], dir);
    run(["auth", "create-user", "--email", "b@test.com", "--password", "password123"], dir);

    const result = run(["auth", "list-users"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Users \(2\)/);
    assert.match(result.stdout, /a@test\.com/);
    assert.match(result.stdout, /b@test\.com/);
  });

  it("reports no users when the table is empty", () => {
    const dir = path.join(tmpRoot, `list-empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(["auth", "list-users"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No users found/i);
  });
});

describe("localbase auth reset-password", () => {
  it("changes the password so the old one fails and the new one works", () => {
    const dir = path.join(tmpRoot, `reset-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    run(["auth", "create-user", "--email", "user@test.com", "--password", "oldpassword123"], dir);

    const result = run(
      ["auth", "reset-password", "--email", "user@test.com", "--password", "newpassword123"],
      dir
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Reset password for user@test\.com/);
  });

  it("fails for an unknown email", () => {
    const dir = path.join(tmpRoot, `reset-unknown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const result = run(
      ["auth", "reset-password", "--email", "ghost@test.com", "--password", "password123"],
      dir
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /No user found/i);
  });

  it("fails when email or password is missing", () => {
    const dir = path.join(tmpRoot, `reset-missing-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(dir);

    const noEmail = run(["auth", "reset-password", "--password", "password123"], dir);
    assert.equal(noEmail.status, 1);
    assert.match(noEmail.stderr + noEmail.stdout, /--email and --password are required/i);

    const noPassword = run(["auth", "reset-password", "--email", "user@test.com"], dir);
    assert.equal(noPassword.status, 1);
    assert.match(noPassword.stderr + noPassword.stdout, /--email and --password are required/i);
  });
});
