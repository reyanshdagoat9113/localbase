import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "./config.js";
import type { LocalBaseConfig } from "@localbase/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * M1 — config validation for the scheduled-jobs subsystem.
 *
 * `validateJobs` is exercised end-to-end through `loadConfig`, which is the
 * exact path `localbase dev` uses at startup. Each case writes a throwaway
 * `localbase.config.ts` into a fresh temp dir so jiti loads it for real.
 */

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-jobs-cfg-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Writes a config file whose `jobs` section is the raw `jobsLiteral` string
 * (so we can express arbitrary shapes, including malformed ones), then runs
 * `loadConfig` against it. Returns the loaded config or throws.
 */
async function loadWithJobs(
  jobsLiteral: string
): Promise<LocalBaseConfig> {
  const dir = path.join(tmpRoot, `case-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const contents = `import type { LocalBaseConfig } from "@localbase/shared";
const config: LocalBaseConfig = {
  tables: {
    widgets: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
  ${jobsLiteral}
};
export default config;
`;
  fs.writeFileSync(path.join(dir, "localbase.config.ts"), contents);
  const { config } = await loadConfig(dir);
  return config;
}

describe("validateJobs (via loadConfig) — happy paths", () => {
  it("loads a minimal valid job", async () => {
    const config = await loadWithJobs(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" } }`
    );
    assert.deepEqual(config.jobs, {
      cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" },
    });
  });

  it("loads a job with all optional fields", async () => {
    const config = await loadWithJobs(
      `jobs: {
        nightly: {
          schedule: "0 9 * * 1",
          handler: "./jobs/report.ts",
          timezone: "America/New_York",
          enabled: false,
          description: "Monday 9 AM report",
        },
      }`
    );
    assert.equal(config.jobs?.nightly?.timezone, "America/New_York");
    assert.equal(config.jobs?.nightly?.enabled, false);
    assert.equal(config.jobs?.nightly?.description, "Monday 9 AM report");
  });

  it("loads with no jobs section at all (optional)", async () => {
    const config = await loadWithJobs(``);
    assert.equal(config.jobs, undefined);
  });
});

describe("validateJobs (via loadConfig) — rejections", () => {
  async function expectConfigError(
    jobsLiteral: string,
    pattern: RegExp
  ): Promise<void> {
    await assert.rejects(
      () => loadWithJobs(jobsLiteral),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, "expected a ConfigError");
        assert.match(err.message, pattern);
        return true;
      }
    );
  }

  it("rejects a non-object jobs section", async () => {
    await expectConfigError(`jobs: "not an object"`, /"jobs" must be an object/);
  });

  it("rejects an array jobs section", async () => {
    await expectConfigError(
      `jobs: [{ schedule: "0 3 * * *", handler: "./x.ts" }]`,
      /"jobs" must be an object/
    );
  });

  it("rejects an invalid job name", async () => {
    await expectConfigError(
      `jobs: { "bad-name": { schedule: "0 3 * * *", handler: "./x.ts" } }`,
      /job name "bad-name" is invalid/
    );
  });

  it("rejects a missing schedule", async () => {
    await expectConfigError(
      `jobs: { cleanup: { handler: "./x.ts" } }`,
      /must have a non-empty "schedule"/
    );
  });

  it("rejects a malformed cron expression", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 foo * * *", handler: "./x.ts" } }`,
      /is not a valid cron expression/
    );
  });

  it("rejects an out-of-range cron value", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "99 * * * *", handler: "./x.ts" } }`,
      /is not a valid cron expression/
    );
  });

  it("rejects a 6-field (seconds-precision) schedule", async () => {
    // croner accepts 6 fields, but LocalBase restricts to 5-field cron.
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 */5 * * * *", handler: "./x.ts" } }`,
      /must be a standard 5-field cron/
    );
  });

  it("rejects a too-short schedule", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "* * *", handler: "./x.ts" } }`,
      /must be a standard 5-field cron/
    );
  });

  it("rejects a missing handler", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *" } }`,
      /must have a non-empty "handler"/
    );
  });

  it("rejects an empty handler string", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: "" } }`,
      /must have a non-empty "handler"/
    );
  });

  it("rejects a non-string handler", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: 42 } }`,
      /must have a non-empty "handler"/
    );
  });

  it("rejects an invalid IANA timezone", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: "./x.ts", timezone: "Mars/Olympus" } }`,
      /invalid "timezone"/
    );
  });

  it("rejects a non-boolean enabled", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: "./x.ts", enabled: "yes" } }`,
      /non-boolean "enabled"/
    );
  });

  it("rejects a non-string description", async () => {
    await expectConfigError(
      `jobs: { cleanup: { schedule: "0 3 * * *", handler: "./x.ts", description: 7 } }`,
      /non-string "description"/
    );
  });

  it("rejects a job whose value is not an object", async () => {
    await expectConfigError(
      `jobs: { cleanup: "midnight" }`,
      /must be an object with "schedule" and "handler"/
    );
  });
});

// ─── Example project configs ────────────────────────────────────

describe("example configs load and validate", () => {
  it("loads the task-board example config with auth + policies", async () => {
    const exampleDir = path.resolve(__dirname, "../../../examples/task-board");
    const { config } = await loadConfig(exampleDir);

    assert.equal(config.auth?.enabled, true);
    assert.equal(typeof config.auth?.jwtSecret, "string");
    assert.ok(config.tables.projects);
    assert.ok(config.tables.tasks);
    assert.ok(config.tables.columns);
    assert.ok(config.tables.labels);
    assert.ok(config.tables.task_labels);
    assert.ok(config.tables.comments);
    assert.deepEqual(config.policies, { projects: { ownerColumn: "owner_id" } });
  });
});
