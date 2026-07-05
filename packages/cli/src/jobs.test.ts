import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { Database } from "@localbase/core";

/**
 * M4 — CLI scheduled-jobs commands.
 *
 * Covers `localbase jobs list`, `localbase jobs run <name>`, and
 * `localbase jobs logs <name>`. Like admin.test.ts / auth.test.ts, these
 * spawn the real CLI entry point via tsx in isolated temp projects so the
 * command's own `process.exit` behaviour doesn't affect the test runner.
 *
 * `jobs run`/`jobs logs` are additionally verified directly against the
 * `_job_runs` table (opened with @localbase/core) to confirm the manual run
 * really wrote a row, not just that the command printed something.
 */

let tmpRoot: string;
let repoRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-cli-jobs-"));
  repoRoot = process.cwd();
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write a project config with a single job pointing at a handler file. */
function writeProject(
  dir: string,
  opts: { handlerSource?: string; omitJobs?: boolean; paused?: boolean } = {}
): void {
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  const handlerSource =
    opts.handlerSource ??
    `export default async ({ log }) => { log("hello from job"); };`;
  fs.writeFileSync(path.join(dir, "jobs", "handler.ts"), handlerSource);

  const jobsBlock = opts.omitJobs
    ? ""
    : `jobs: {
        cleanup: {
          schedule: "0 3 * * *",
          handler: "./jobs/handler.ts",
          description: "nightly cleanup",
          ${opts.paused ? "enabled: false," : ""}
        },
      },`;

  fs.writeFileSync(
    path.join(dir, "localbase.config.ts"),
    `export default {
  tables: {
    items: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
  ${jobsBlock}
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

/** Open the project's DB directly to inspect `_job_runs` rows. */
function openDb(dir: string): Database {
  const dbPath = path.join(dir, ".localbase", "data.db");
  return new Database({
    path: dbPath,
    schema: {
      items: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "text", nullable: false },
      },
    },
    jobs: {
      cleanup: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" },
    },
  });
}

interface JobRunRow {
  id: number;
  job_name: string;
  status: string;
  output: string | null;
  error: string | null;
}

function runsFor(db: Database, name: string): JobRunRow[] {
  return db.select("_job_runs", {
    filters: [{ column: "job_name", operator: "eq", value: name }],
    orderBy: [{ column: "id", direction: "desc" }],
  }) as JobRunRow[];
}

describe("localbase jobs command registration", () => {
  it("shows the jobs subcommands in --help", () => {
    const dir = path.join(tmpRoot, `help-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir);

    const result = run(["jobs", "--help"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\blist\b/);
    assert.match(result.stdout, /\brun\b/);
    assert.match(result.stdout, /\blogs\b/);
  });
});

describe("localbase jobs list", () => {
  it("lists a registered job with schedule, enabled state, and a next run", () => {
    const dir = path.join(tmpRoot, `list-one-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir);

    const result = run(["jobs", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Jobs \(1\)/);
    assert.match(result.stdout, /cleanup/);
    assert.match(result.stdout, /0 3 \* \* \*/);
    assert.match(result.stdout, /enabled/);
    assert.match(result.stdout, /next:/i);
    // Description is surfaced too.
    assert.match(result.stdout, /nightly cleanup/);
  });

  it("reports no jobs when the config has no jobs map", () => {
    const dir = path.join(tmpRoot, `list-empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, { omitJobs: true });

    const result = run(["jobs", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No jobs configured/i);
  });

  it("marks an enabled:false job as paused and shows no next run", () => {
    const dir = path.join(tmpRoot, `list-paused-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, { paused: true });

    const result = run(["jobs", "list"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /paused/);
    // A paused job reports next run as "—" (no dash in the next-run slot
    // would be wrong); assert the em dash placeholder appears.
    assert.match(result.stdout, /next:\s+—/);
  });
});

describe("localbase jobs run <name>", () => {
  it("triggers the job immediately and writes a success row in _job_runs", () => {
    const dir = path.join(tmpRoot, `run-ok-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, {
      handlerSource: `export default async ({ log }) => { log("ran now"); };`,
    });

    const result = run(["jobs", "run", "cleanup"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Ran "cleanup"/);
    assert.match(result.stdout, /run #1/);

    // Verify against the DB: exactly one success row for this job.
    const db = openDb(dir);
    try {
      const rows = runsFor(db, "cleanup");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "success");
      assert.match(rows[0].output as string, /ran now/);
    } finally {
      db.close();
    }
  });

  it("records a failed run and exits non-zero", () => {
    const dir = path.join(tmpRoot, `run-fail-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, {
      handlerSource: `export default async () => { throw new Error("boom"); };`,
    });

    const result = run(["jobs", "run", "cleanup"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /failed/i);
    assert.match(result.stdout + result.stderr, /boom/);

    const db = openDb(dir);
    try {
      const rows = runsFor(db, "cleanup");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "failed");
      assert.equal(rows[0].error, "boom");
    } finally {
      db.close();
    }
  });

  it("fails for an unknown job name (no row written)", () => {
    const dir = path.join(tmpRoot, `run-unknown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir);

    const result = run(["jobs", "run", "ghost"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /Unknown job/i);

    const db = openDb(dir);
    try {
      assert.equal(runsFor(db, "ghost").length, 0);
      assert.equal(runsFor(db, "cleanup").length, 0);
    } finally {
      db.close();
    }
  });
});

describe("localbase jobs logs <name>", () => {
  it("renders run history newest-first after manual runs", () => {
    const dir = path.join(tmpRoot, `logs-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, {
      handlerSource: `export default async ({ log }) => { log("tick"); };`,
    });

    // Produce two runs so ordering + count are observable.
    run(["jobs", "run", "cleanup"], dir);
    run(["jobs", "run", "cleanup"], dir);

    const result = run(["jobs", "logs", "cleanup"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Runs for "cleanup"/);
    assert.match(result.stdout, /\(2 total/);
    // Both run ids appear, newest first (#2 before #1).
    assert.match(result.stdout, /#2/);
    assert.match(result.stdout, /#1/);
    const id2 = result.stdout.indexOf("#2");
    const id1 = result.stdout.indexOf("#1");
    assert.ok(id2 < id1 && id2 >= 0, "#2 should appear before #1");
    // The success status line and captured output are surfaced.
    assert.match(result.stdout, /success/);
    assert.match(result.stdout, /tick/);
  });

  it("reports no runs when the job has never fired", () => {
    const dir = path.join(tmpRoot, `logs-empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir);

    const result = run(["jobs", "logs", "cleanup"], dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No runs recorded yet/i);
  });

  it("fails for an unknown job name", () => {
    const dir = path.join(tmpRoot, `logs-unknown-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir);

    const result = run(["jobs", "logs", "ghost"], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /Unknown job/i);
  });

  it("respects --limit", () => {
    const dir = path.join(tmpRoot, `logs-limit-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    writeProject(dir, {
      handlerSource: `export default async ({ log }) => { log("tick"); };`,
    });

    for (let i = 0; i < 3; i++) {
      run(["jobs", "run", "cleanup"], dir);
    }

    const result = run(["jobs", "logs", "cleanup", "--limit", "2"], dir);
    assert.equal(result.status, 0);
    // Total is 3, but only 2 rows shown.
    assert.match(result.stdout, /3 total/);
    assert.match(result.stdout, /showing 2/);
    assert.match(result.stdout, /#3/);
    assert.match(result.stdout, /#2/);
    assert.doesNotMatch(result.stdout, /#1/);
  });
});
