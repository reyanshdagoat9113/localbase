import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../db.js";
import { JOBS_SCHEMA } from "./schema.js";
import type { DatabaseSchema } from "@localbase/shared";

const baseSchema: DatabaseSchema = {
  widgets: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};

/** Queries sqlite_master for a table name. */
function tableExists(db: Database, name: string): boolean {
  const row = db
    .raw()
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(name);
  return row !== undefined;
}

/** Returns the column names of a table, in declaration order. */
function columnsOf(db: Database, name: string): string[] {
  const rows = db
    .raw()
    .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
    .all() as Array<{ name: string }>;
  return rows.map((c) => c.name);
}

describe("JOBS_SCHEMA", () => {
  it("defines the _job_runs table with the documented columns", () => {
    assert.ok("_job_runs" in JOBS_SCHEMA, "expected _job_runs in JOBS_SCHEMA");
    const cols = JOBS_SCHEMA._job_runs;
    const expected = [
      "id",
      "job_name",
      "status",
      "started_at",
      "ended_at",
      "duration_ms",
      "output",
      "error",
    ];
    assert.deepEqual(Object.keys(cols), expected);

    assert.equal(cols.id.type, "integer");
    assert.equal(cols.id.primaryKey, true);
    assert.equal(cols.id.autoIncrement, true);

    // The required non-null bookkeeping columns.
    assert.equal(cols.job_name.nullable, false);
    assert.equal(cols.status.nullable, false);
    assert.equal(cols.started_at.nullable, false);
    assert.equal(cols.started_at.default, "CURRENT_TIMESTAMP");

    // Optional outcome columns are nullable.
    assert.equal(cols.ended_at.nullable, undefined);
    assert.equal(cols.duration_ms.nullable, undefined);
    assert.equal(cols.output.nullable, undefined);
    assert.equal(cols.error.nullable, undefined);
  });
});

describe("Database jobs provisioning (M1)", () => {
  it("creates _job_runs after migrate when a jobs map is configured", () => {
    const db = new Database({
      schema: baseSchema,
      jobs: {
        cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" },
      },
    });
    try {
      assert.equal(db.getJobsEnabled(), true);
      assert.ok(tableExists(db, "_job_runs"), "_job_runs should exist");
      assert.ok(
        db.getAppliedMigrations().has("_job_runs"),
        "_job_runs migration should be recorded"
      );
      assert.deepEqual(columnsOf(db, "_job_runs"), [
        "id",
        "job_name",
        "status",
        "started_at",
        "ended_at",
        "duration_ms",
        "output",
        "error",
      ]);
    } finally {
      db.close();
    }
  });

  it("does NOT create _job_runs when no jobs map is configured", () => {
    const db = new Database({ schema: baseSchema });
    try {
      assert.equal(db.getJobsEnabled(), false);
      assert.equal(
        tableExists(db, "_job_runs"),
        false,
        "_job_runs must not exist without a jobs config"
      );
      assert.equal(
        db.getAppliedMigrations().has("_job_runs"),
        false
      );
    } finally {
      db.close();
    }
  });

  it("an empty jobs map still provisions _job_runs (config opted in)", () => {
    const db = new Database({ schema: baseSchema, jobs: {} });
    try {
      assert.equal(db.getJobsEnabled(), true);
      assert.ok(tableExists(db, "_job_runs"));
    } finally {
      db.close();
    }
  });

  it("provisions _job_runs alongside auth and storage system tables", () => {
    const db = new Database({
      schema: baseSchema,
      auth: { enabled: true, jwtSecret: "test-secret-do-not-use-in-prod" },
      jobs: { nightly: { schedule: "0 0 * * *", handler: "./jobs/n.ts" } },
    });
    try {
      assert.ok(tableExists(db, "_job_runs"));
      assert.ok(tableExists(db, "_files"));
      assert.ok(tableExists(db, "_users"));
      assert.ok(tableExists(db, "_sessions"));
      assert.ok(tableExists(db, "widgets"));
    } finally {
      db.close();
    }
  });

  it("preserves _job_runs across reset() (it is a _-prefixed system table)", () => {
    const db = new Database({
      schema: baseSchema,
      jobs: { cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" } },
    });
    try {
      db.insert("_job_runs", {
        job_name: "cleanup",
        status: "success",
      });
      assert.equal(db.select("_job_runs").length, 1);

      db.reset();

      // User table was wiped...
      assert.equal(db.select("widgets").length, 0);
      // ...but the system job-run table survives reset.
      assert.ok(tableExists(db, "_job_runs"));
      assert.equal(
        db.select("_job_runs").length,
        1,
        "_job_runs rows must survive reset()"
      );
    } finally {
      db.close();
    }
  });
});
