import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../db.js";
import { Scheduler } from "./scheduler.js";
import { JobError } from "./runner.js";
import type { DatabaseSchema, JobConfig } from "@localbase/shared";

/**
 * M3 — Scheduler.
 *
 * These tests exercise the cron-driven lifecycle: arming timers on `start()`,
 * a real near-future firing writing a `_job_runs` row, `stop()` cancelling
 * further firings, the manual `runNow` path, and the overlap-skip guarantee.
 *
 * Per the jobs plan (Risks #2) we never sleep for whole minutes in CI. The
 * "fires on schedule" cases use a sub-minute schedule so a firing lands within
 * a couple of seconds — fast enough to stay non-flaky while still proving the
 * cron → runner → row wiring end-to-end. (The scheduler delegates cron parsing
 * to `croner`, which accepts sub-minute expressions; the 5-field restriction is
 * a config-loader concern, not enforced here.)
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-jobs-sched-"));
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

function makeScheduler(
  cwd: string,
  jobs: Record<string, JobConfig>,
  db?: Database
): { scheduler: Scheduler; db: Database } {
  const database =
    db ?? new Database({ schema: baseSchema, jobs, dataDir: cwd });
  return {
    scheduler: new Scheduler({ db: database, cwd, jobs }),
    db: database,
  };
}

/** Read all `_job_runs` rows (newest-first by started_at), cast to the row shape. */
function runs(db: Database): JobRunRow[] {
  return db.select("_job_runs", {
    orderBy: [{ column: "started_at", direction: "desc" }],
  }) as JobRunRow[];
}

/** Count `_job_runs` rows. */
function runCount(db: Database): number {
  return db.count("_job_runs");
}

/**
 * Resolve once `_job_runs` has at least `expected` rows, polling every ~50ms
 * up to `timeoutMs`. Used to await a real cron firing without sleeping for the
 * full interval. Rejects on timeout so a regression surfaces loudly.
 */
async function waitForRuns(
  db: Database,
  expected: number,
  timeoutMs = 6000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runCount(db) >= expected) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timed out waiting for ${expected} run row(s); got ${runCount(db)}`
  );
}

describe("Scheduler.start/stop — lifecycle", () => {
  it("start() is idempotent (does not double-arm timers)", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { a: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();
      assert.equal(scheduler.isStarted(), true);
      const firstNext = scheduler.getNextRun("a")?.getTime();

      // A second start() must not replace/re-arm the cron.
      scheduler.start();
      assert.equal(scheduler.isStarted(), true);
      const secondNext = scheduler.getNextRun("a")?.getTime();
      assert.equal(firstNext, secondNext);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("stop() is safe when never started and clears the started flag", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { a: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      assert.equal(scheduler.isStarted(), false);
      scheduler.stop(); // no-op, must not throw
      assert.equal(scheduler.isStarted(), false);
    } finally {
      db.close();
    }
  });

  it("start() can re-arm after stop() (hot-reload path)", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { a: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();
      assert.equal(scheduler.isStarted(), true);
      scheduler.stop();
      assert.equal(scheduler.isStarted(), false);
      assert.equal(scheduler.getNextRun("a"), null, "no next run after stop");

      scheduler.start();
      assert.equal(scheduler.isStarted(), true);
      assert.ok(
        scheduler.getNextRun("a") instanceof Date,
        "next run restored on re-arm"
      );
    } finally {
      scheduler.stop();
      db.close();
    }
  });
});

describe("Scheduler — disabled jobs are registered-but-paused", () => {
  it("does not arm a cron for enabled: false and reports nextRun null", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = {
      active: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" },
      paused: {
        schedule: "0 3 * * *",
        handler: "./jobs/handler.ts",
        enabled: false,
      },
    };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();

      const summary = new Map(scheduler.listJobs().map((j) => [j.name, j]));
      assert.equal(summary.get("active")?.enabled, true);
      assert.ok(summary.get("active")?.nextRun instanceof Date);
      assert.equal(summary.get("paused")?.enabled, false);
      assert.equal(summary.get("paused")?.nextRun, null);

      // getNextRun reflects the disabled state too.
      assert.ok(scheduler.getNextRun("active") instanceof Date);
      assert.equal(scheduler.getNextRun("paused"), null);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("never fires a disabled job even on a tight schedule", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = {
      paused: {
        schedule: "* * * * * *", // every second — would fire almost immediately
        handler: "./jobs/handler.ts",
        enabled: false,
      },
    };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();
      // Wait long enough that an armed every-second job would have fired
      // several times. No rows should appear.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(runCount(db), 0, "a disabled job must never fire");
    } finally {
      scheduler.stop();
      db.close();
    }
  });
});

describe("Scheduler — fires on schedule", () => {
  it("a registered job fires on its cron schedule and records a row", async () => {
    const cwd = writeHandler(
      `export default async ({ log }) => { log("cron-fired"); };`
    );
    // Sub-minute schedule (every second) so the test resolves in ~1s.
    const jobs = { tick: { schedule: "* * * * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();
      await waitForRuns(db, 1);

      const row = runs(db)[0];
      assert.equal(row.job_name, "tick");
      assert.equal(row.status, "success");
      assert.match(row.output as string, /cron-fired/);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("stop() cancels all future firings", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { tick: { schedule: "* * * * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      scheduler.start();
      await waitForRuns(db, 1);
      const countAfterFirst = runCount(db);
      assert.ok(countAfterFirst >= 1, "job should have fired at least once");

      scheduler.stop();

      // After stop, wait through what would be several more firings and confirm
      // the count did not grow.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(
        runCount(db),
        countAfterFirst,
        "no new runs after stop()"
      );
    } finally {
      db.close();
    }
  });
});

describe("Scheduler.runNow — manual trigger", () => {
  it("runs a registered job immediately and records the outcome", async () => {
    const cwd = writeHandler(
      `export default async ({ db, log }) => {
        log("manual");
        db.insert("sessions", { expires_at: "2025-01-01T00:00:00Z" });
        return { ok: true };
      };`
    );
    const jobs = { cleanup: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      const result = await scheduler.runNow("cleanup");
      assert.equal(result.status, "success");
      assert.ok(typeof result.runId, "number");

      const row = runs(db)[0];
      assert.equal(row.job_name, "cleanup");
      assert.equal(row.status, "success");
      assert.match(row.output as string, /manual/);
      assert.match(row.output as string, /"ok":true/);

      // The handler really got the live Database.
      assert.equal(db.select("sessions").length, 1);
    } finally {
      db.close();
    }
  });

  it("records a failed run when the handler throws", async () => {
    const cwd = writeHandler(
      `export default async () => { throw new Error("boom"); };`
    );
    const jobs = { bad: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      const result = await scheduler.runNow("bad");
      assert.equal(result.status, "failed");
      assert.equal(runs(db)[0].error, "boom");
    } finally {
      db.close();
    }
  });

  it("throws JobError for an unknown job name (no row written)", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { known: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      await assert.rejects(() => scheduler.runNow("nope"), (err: unknown) => {
        assert.ok(err instanceof JobError);
        assert.match((err as Error).message, /Unknown job/);
        return true;
      });
      assert.equal(runCount(db), 0);
    } finally {
      db.close();
    }
  });
});

describe("Scheduler — concurrency (overlap is skipped)", () => {
  it("runNow while the handler is still running returns skipped (no extra row)", async () => {
    const cwd = writeHandler(
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      export default async ({ log }) => {
        log("started");
        await wait(1500);
        log("done");
      };`
    );
    const jobs = { slow: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      // Fire the first run but don't await; let it enter the running set.
      const first = scheduler.runNow("slow");
      await new Promise((r) => setImmediate(r));
      assert.ok(
        scheduler.getRunner().isRunning("slow"),
        "first run should be in flight"
      );

      const second = await scheduler.runNow("slow");
      assert.equal(second.status, "skipped");
      assert.equal(second.runId, null, "skipped firings write no row");

      await first;
      assert.equal(
        scheduler.getRunner().isRunning("slow"),
        false,
        "released after finish"
      );

      // Exactly one row — the overlap was dropped, not queued.
      assert.equal(runCount(db), 1);
      assert.equal(runs(db)[0].status, "success");
    } finally {
      db.close();
    }
  });
});

describe("Scheduler — readers", () => {
  it("listJobs merges config, nextRun, and the latest run status", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = {
      alpha: {
        schedule: "0 3 * * *",
        handler: "./jobs/handler.ts",
        timezone: "America/New_York",
        description: "nightly cleanup",
      },
      beta: { schedule: "0 4 * * *", handler: "./jobs/handler.ts" },
    };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      // Before any run: lastRun/lastStatus are null.
      let summaries = scheduler.listJobs();
      assert.deepEqual(
        summaries.map((s) => s.name),
        ["alpha", "beta"]
      );
      const alphaBefore = summaries[0];
      assert.equal(alphaBefore.schedule, "0 3 * * *");
      assert.equal(alphaBefore.timezone, "America/New_York");
      assert.equal(alphaBefore.enabled, true);
      assert.equal(alphaBefore.description, "nightly cleanup");
      assert.equal(alphaBefore.lastRun, null);
      assert.equal(alphaBefore.lastStatus, null);
      assert.equal(alphaBefore.nextRun, null, "nextRun null before start");

      scheduler.start();
      summaries = scheduler.listJobs();
      assert.ok(
        summaries[0].nextRun instanceof Date,
        "nextRun is a Date after start"
      );

      // Run alpha manually; its lastRun/lastStatus should reflect the result.
      await scheduler.runNow("alpha");
      summaries = scheduler.listJobs();
      const alphaAfter = summaries.find((s) => s.name === "alpha")!;
      assert.equal(alphaAfter.lastStatus, "success");
      assert.ok(alphaAfter.lastRun, "lastRun set after a run");
      // beta still has no runs.
      const betaAfter = summaries.find((s) => s.name === "beta")!;
      assert.equal(betaAfter.lastRun, null);
      assert.equal(betaAfter.lastStatus, null);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("getNextRun throws JobError for an unknown job", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { known: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);
    try {
      assert.throws(() => scheduler.getNextRun("nope"), JobError);
    } finally {
      db.close();
    }
  });

  it("getRuns paginates history newest-first with a total", async () => {
    const cwd = writeHandler(
      `export default async ({ log }) => { log("run"); };`
    );
    const jobs = { repeat: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      for (let i = 0; i < 3; i++) {
        await scheduler.runNow("repeat");
      }

      // Page of 2.
      const page = scheduler.getRuns("repeat", { limit: 2, offset: 0 });
      assert.equal(page.runs.length, 2);
      assert.equal(page.total, 3, "total ignores limit/offset");

      // Newest-first: the first row has the highest id.
      assert.ok(page.runs[0].id > page.runs[1].id, "ordered newest-first");

      // Second page returns the remaining row.
      const page2 = scheduler.getRuns("repeat", { limit: 2, offset: 2 });
      assert.equal(page2.runs.length, 1);
      assert.equal(page2.total, 3);
    } finally {
      db.close();
    }
  });

  it("getRuns applies defaults (limit 50, offset 0) and throws for unknown jobs", async () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { once: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    try {
      await scheduler.runNow("once");
      const all = scheduler.getRuns("once");
      assert.equal(all.runs.length, 1);
      assert.equal(all.total, 1);

      assert.throws(() => scheduler.getRuns("missing"), JobError);
    } finally {
      db.close();
    }
  });
});

describe("Scheduler — index provisioning", () => {
  it("start() creates the _job_runs history index idempotently", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { a: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    const { scheduler, db } = makeScheduler(cwd, jobs);

    const hasIndex = (): boolean =>
      db
        .raw()
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = '_job_runs_name_started_idx'`
        )
        .get() !== undefined;

    try {
      assert.equal(hasIndex(), false, "index absent before start");
      scheduler.start();
      assert.equal(hasIndex(), true, "index created on start");
      // Calling ensureIndexes again (or start again) is a no-op.
      scheduler.ensureIndexes();
      assert.equal(hasIndex(), true);
    } finally {
      scheduler.stop();
      db.close();
    }
  });

  it("ensureIndexes is a safe no-op when _job_runs does not exist", () => {
    const cwd = writeHandler(`export default async () => {}`);
    const jobs = { a: { schedule: "0 3 * * *", handler: "./jobs/handler.ts" } };
    // Deliberately omit `jobs` from DatabaseOptions so `_job_runs` is absent.
    const db = new Database({ schema: baseSchema, dataDir: cwd });
    const { scheduler } = makeScheduler(cwd, jobs, db);

    try {
      // Must not throw on a table that isn't there.
      scheduler.ensureIndexes();
    } finally {
      db.close();
    }
  });
});
