import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../db.js";
import { JobRunner, JobError } from "./runner.js";
import type { DatabaseSchema, JobConfig } from "@localbase/shared";

/**
 * M2 — Job runner.
 *
 * Each case writes real handler files into a fresh temp dir and loads them
 * through `jiti`, exactly as `JobRunner` does in production. The runner is
 * the sole writer of `_job_runs`, so these tests assert the full lifecycle:
 * a `running` row is inserted on fire and updated to `success` | `failed`
 * (or `skipped`, with no row, on re-entry).
 */

const baseSchema: DatabaseSchema = {
  sessions: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    expires_at: { type: "text" },
  },
};

interface JobRunRow {
  id: number;
  job_name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  output: string | null;
  error: string | null;
}

let tmpRoot: string;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-jobs-runner-"));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write a handler file under a fresh sub-dir and return that cwd. */
function writeHandler(source: string): string {
  const dir = path.join(
    tmpRoot,
    `case-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "jobs", "handler.ts"), source);
  return dir;
}

function makeRunner(
  cwd: string,
  jobs: Record<string, JobConfig>,
  db?: Database
): { runner: JobRunner; db: Database } {
  const database =
    db ??
    new Database({ schema: baseSchema, jobs, dataDir: cwd });
  return { runner: new JobRunner({ db: database, cwd, jobs }), db: database };
}

/** Read all `_job_runs` rows (newest-first by id), cast to the row shape. */
function runs(db: Database): JobRunRow[] {
  return db.select("_job_runs", {
    orderBy: [{ column: "id", direction: "desc" }],
  }) as JobRunRow[];
}

describe("JobRunner.run — happy path", () => {
  it("records a success run with log lines + serialized return value", async () => {
    const cwd = writeHandler(
      `export default async ({ db, log, name }) => {
        log("step one");
        log("step two");
        db.insert("sessions", { expires_at: "2025-01-01T00:00:00Z" });
        return { deleted: 1, name };
      }`
    );
    const jobs = { cleanup: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("cleanup");
      assert.equal(result.status, "success");
      assert.ok(typeof result.runId, "number");

      const row = runs(db)[0];
      assert.equal(row.job_name, "cleanup");
      assert.equal(row.status, "success");
      assert.ok(row.ended_at, "ended_at must be set on success");
      assert.equal(typeof row.duration_ms, "number");
      assert.ok((row.duration_ms as number) >= 0);
      assert.equal(row.error, null);

      // log() lines are present, in order...
      assert.match(row.output as string, /step one/);
      assert.match(row.output as string, /step two/);
      // ...and the serialized return value is appended.
      assert.match(row.output as string, /"deleted":1/);
      assert.match(row.output as string, /"name":"cleanup"/);

      // The handler really did get the live Database — its insert landed.
      assert.equal(db.select("sessions").length, 1);
    } finally {
      db.close();
    }
  });

  it("records a success run with no output when the handler returns undefined", async () => {
    const cwd = writeHandler(`export default async () => { /* noop */ }`);
    const jobs = { noop: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("noop");
      assert.equal(result.status, "success");
      const row = runs(db)[0];
      assert.equal(row.output, "");
    } finally {
      db.close();
    }
  });

  it("inserts a running row before updating it (lifecycle is two writes)", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { probe: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    let sawRunning = false;
    db.on("change", (evt) => {
      if (evt.table === "_job_runs") {
        const row = evt.row as JobRunRow;
        if (row.status === "running") sawRunning = true;
      }
    });

    try {
      await runner.run("probe");
      assert.ok(sawRunning, "a running row should have been inserted first");
      // And it ended as success — the only persisted row.
      assert.equal(runs(db)[0].status, "success");
    } finally {
      db.close();
    }
  });
});

describe("JobRunner.run — failure handling", () => {
  it("records a thrown error as a failed run with the message", async () => {
    const cwd = writeHandler(
      `export default async ({ log }) => {
        log("before failure");
        throw new Error("sessions table missing");
      }`
    );
    const jobs = { cleanup: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("cleanup");
      assert.equal(result.status, "failed");

      const row = runs(db)[0];
      assert.equal(row.status, "failed");
      assert.equal(row.error, "sessions table missing");
      assert.ok(row.ended_at);
      // log() lines before the throw are preserved.
      assert.match(row.output as string, /before failure/);
    } finally {
      db.close();
    }
  });

  it("records a non-function default export as a failed run (no crash)", async () => {
    const cwd = writeHandler(`export default { not: "a function" }`);
    const jobs = { bad: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("bad");
      assert.equal(result.status, "failed");
      const row = runs(db)[0];
      assert.equal(row.status, "failed");
      assert.match(
        row.error as string,
        /must default-export a function/,
        "error should explain the export shape"
      );
    } finally {
      db.close();
    }
  });

  it("records a missing handler file as a failed run", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = {
      ghost: { schedule: "0 3 * * *", handler: "./jobs/does-not-exist.ts" },
    };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("ghost");
      assert.equal(result.status, "failed");
      const row = runs(db)[0];
      assert.match(row.error as string, /Could not load job handler/);
    } finally {
      db.close();
    }
  });

  it("treats a synchronous throw inside the handler as a failure", async () => {
    const cwd = writeHandler(
      `export default () => { throw new Error("sync boom"); }`
    );
    const jobs = { sync: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("sync");
      assert.equal(result.status, "failed");
      assert.equal(runs(db)[0].error, "sync boom");
    } finally {
      db.close();
    }
  });
});

describe("JobRunner.run — concurrency guard", () => {
  it("skips a second firing while the first is still running (no row written)", async () => {
    // Handler blocks on a gate we control so the first run stays in-flight.
    const cwd = writeHandler(
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      export default async ({ log }) => {
        log("started");
        await wait(2000);
        log("finished");
      };`
    );
    const jobs = { slow: { schedule: "* * * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      // Fire the first run but do NOT await it yet.
      const first = runner.run("slow");
      // Give the handler a tick to enter the running set.
      await new Promise((r) => setImmediate(r));
      assert.ok(runner.isRunning("slow"), "first run should be in flight");

      const second = await runner.run("slow");
      assert.equal(second.status, "skipped");
      assert.equal(second.runId, null, "skipped firings write no row");

      await first;
      assert.equal(runner.isRunning("slow"), false, "released after finish");

      // Exactly one run row — the overlapping firing was dropped, not queued.
      assert.equal(runs(db).length, 1);
      assert.equal(runs(db)[0].status, "success");
    } finally {
      db.close();
    }
  });
});

describe("JobRunner.run — output capping", () => {
  it("truncates output that exceeds the cap and marks it", async () => {
    // 200 KB of log lines — well over the 64 KiB cap.
    const cwd = writeHandler(
      `export default async ({ log }) => {
        for (let i = 0; i < 20000; i++) log("x".repeat(10));
      };`
    );
    const jobs = { chatty: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      const result = await runner.run("chatty");
      assert.equal(result.status, "success");
      const row = runs(db)[0];
      assert.ok(
        Buffer.byteLength(row.output as string, "utf8") <= 64 * 1024,
        "stored output must not exceed the cap"
      );
      assert.match(row.output as string, /\[output truncated\]/);
    } finally {
      db.close();
    }
  });
});

describe("JobRunner.run — registry guards", () => {
  it("throws JobError for an unknown job name", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { known: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { runner, db } = makeRunner(cwd, jobs);

    try {
      await assert.rejects(() => runner.run("unknown"), (err: unknown) => {
        assert.ok(err instanceof JobError);
        assert.match((err as Error).message, /Unknown job/);
        return true;
      });
      // No row should have been written for the unknown name.
      assert.equal(runs(db).length, 0);
    } finally {
      db.close();
    }
  });
});

describe("JobRunner — readers", () => {
  it("getJob / getJobNames / isRunning reflect the registry and state", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = {
      alpha: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" },
      beta: { schedule: "0 4 * * *", handler: "./jobs/handler.ts" },
    };
    const { runner, db } = makeRunner(cwd, jobs);
    try {
      assert.deepEqual(runner.getJobNames().sort(), ["alpha", "beta"]);
      assert.equal(runner.getJob("alpha")?.schedule, "0 3 * * *");
      assert.equal(runner.getJob("missing"), undefined);
      assert.equal(runner.isRunning("alpha"), false);
    } finally {
      db.close();
    }
  });
});
