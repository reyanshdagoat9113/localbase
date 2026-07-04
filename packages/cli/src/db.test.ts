import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "@localbase/core";
import { migrateCommand } from "./db.js";

function withTempProject(fn: (dir: string) => Promise<void> | void) {
  const previousCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-jobs-db-"));
  process.chdir(dir);
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      process.chdir(previousCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function tableExists(dbPath: string, name: string): boolean {
  const db = new Database({
    path: dbPath,
    schema: {},
    autoMigrate: false,
  });
  try {
    const row = db
      .raw()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return row !== undefined;
  } finally {
    db.close();
  }
}

describe("database CLI commands", () => {
  it("passes configured jobs into Database so migrate provisions _job_runs", async () => {
    await withTempProject(async (dir) => {
      fs.writeFileSync(
        path.join(dir, "localbase.config.ts"),
        `export default {
  tables: {
    widgets: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "text", nullable: false },
    },
  },
  jobs: {
    cleanup: { schedule: "0 3 * * *", handler: "./jobs/cleanup.ts" },
  },
};\n`
      );

      await migrateCommand();

      assert.equal(
        tableExists(path.join(dir, ".localbase", "data.db"), "_job_runs"),
        true,
        "migrateCommand should create the jobs system table when config.jobs is present"
      );
    });
  });
});
