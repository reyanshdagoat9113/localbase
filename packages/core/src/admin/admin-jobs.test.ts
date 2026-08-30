import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSchema, JobConfig } from "@localbase/shared";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import { Auth } from "../auth/auth.js";
import { resolveAuthConfig } from "../auth/config.js";
import { Scheduler } from "../jobs/scheduler.js";

const schema: DatabaseSchema = {
  notes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    value: { type: "text" },
  },
};
const secret = "admin-jobs-test-secret";
let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-admin-jobs-"));
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "jobs", "cleanup.ts"),
    'export default async ({ log }) => { log("cleaned"); };'
  );
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(auth = false) {
  const jobs: Record<string, JobConfig> = {
    cleanup: {
      schedule: "0 3 * * *",
      handler: "./jobs/cleanup.ts",
      description: "Remove expired data",
    },
  };
  const authConfig = auth
    ? { enabled: true, jwtSecret: secret }
    : { enabled: false };
  const db = new Database({ schema, jobs, auth: authConfig, dataDir: root });
  const scheduler = new Scheduler({ db, cwd: root, jobs });
  scheduler.start();
  const app = createServer(db, schema, {
    auth: authConfig,
    admin: { enabled: true },
    scheduler,
  });
  return { app, db, scheduler };
}

describe("admin jobs API", () => {
  it("lists registered jobs and rejects unknown names", async () => {
    const { app, db, scheduler } = setup();
    try {
      const list = await app.request("/_api/admin/jobs");
      assert.equal(list.status, 200);
      const body = await list.json();
      assert.equal(body.data[0].name, "cleanup");
      assert.equal(body.data[0].description, "Remove expired data");

      const missing = await app.request("/_api/admin/jobs/../secrets/run", {
        method: "POST",
      });
      assert.equal(missing.status, 404);
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      db.close();
    }
  });

  it("triggers a run asynchronously and paginates history", async () => {
    const { app, db, scheduler } = setup();
    try {
      for (let index = 0; index < 3; index++) {
        const response = await app.request("/_api/admin/jobs/cleanup/run", {
          method: "POST",
        });
        assert.equal(response.status, 202);
        const body = await response.json();
        assert.equal(typeof body.data.runId, "number");
        await scheduler.waitForIdle();
      }

      const page = await app.request(
        "/_api/admin/jobs/cleanup/runs?limit=2&offset=1"
      );
      assert.equal(page.status, 200);
      const body = await page.json();
      assert.equal(body.data.runs.length, 2);
      assert.equal(body.data.total, 3);
      assert.ok(body.data.runs.every((run: { status: string }) => run.status === "success"));
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      db.close();
    }
  });

  it("inherits the admin gate and rejects a regular user", async () => {
    const { app, db, scheduler } = setup(true);
    try {
      const { config } = resolveAuthConfig({ enabled: true, jwtSecret: secret });
      const auth = new Auth(db, config);
      await auth.signUp({ email: "owner@example.com", password: "password123" });
      const user = await auth.signUp({ email: "user@example.com", password: "password123" });

      const response = await app.request("/_api/admin/jobs", {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assert.equal(response.status, 403);
    } finally {
      scheduler.stop();
      await scheduler.waitForIdle();
      db.close();
    }
  });
});
