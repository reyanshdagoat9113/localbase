import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "@localbase/core";
import { collectStatus, diffSchema } from "./status.js";
import { cliInvocation } from "./invocation.js";
import { DB_DIR, DB_FILE } from "./config.js";

let root: string;

// Each test gets its own project dir: jiti caches config modules by path.
function project(name: string, body: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "localbase.config.ts"), `export default ${body};\n`);
  return dir;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-status-"));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("diffSchema", () => {
  it("reports pending tables, pending columns, and undeclared columns", () => {
    const diff = diffSchema(
      {
        posts: { id: { type: "integer", primaryKey: true }, title: { type: "text" } },
        tags: { id: { type: "integer", primaryKey: true } },
      },
      {
        tables: [
          {
            name: "posts",
            columns: [
              { name: "id" },
              { name: "legacy" },
            ],
          },
        ],
      } as never
    );
    assert.deepEqual(diff, {
      pendingTables: ["tags"],
      pendingColumns: ["posts.title"],
      undeclaredColumns: ["posts.legacy"],
    });
  });
});

describe("collectStatus", () => {
  it("works before the database exists and does not create it", async () => {
    const dir = project("fresh", `{ tables: { notes: { id: { type: "integer", primaryKey: true } } } }`);
    const report = await collectStatus({ port: 1 }, dir);
    assert.equal(report.database.exists, false);
    assert.equal(report.schema, null);
    assert.equal(report.server.listening, false);
    assert.equal(report.auth.enabled, true);
    assert.deepEqual(report.auth.unprotectedTables, ["notes"]);
    assert.equal(fs.existsSync(path.join(dir, DB_DIR, DB_FILE)), false);
  });

  it("detects pending columns without migrating them", async () => {
    const dir = project("drift", `{
      auth: { enabled: false },
      tables: { notes: { id: { type: "integer", primaryKey: true }, body: { type: "text" } } },
    }`);
    const dbDir = path.join(dir, DB_DIR);
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, DB_FILE);
    const db = await Database.open({
      path: dbPath,
      schema: { notes: { id: { type: "integer", primaryKey: true } } },
      dataDir: dbDir,
    });
    try {
      await db.insert("notes", { id: 1 });
    } finally {
      await db.close();
    }

    const report = await collectStatus({ port: 1 }, dir);
    assert.equal(report.database.exists, true);
    assert.deepEqual(report.schema?.pendingColumns, ["notes.body"]);
    assert.deepEqual(report.tables, [{ name: "notes", rows: 1 }]);
    assert.equal(report.auth.enabled, false);
    assert.deepEqual(report.auth.unprotectedTables, []);

    // Still pending on a second run: status must not have migrated anything.
    const again = await collectStatus({ port: 1 }, dir);
    assert.deepEqual(again.schema?.pendingColumns, ["notes.body"]);
  });
});

describe("cliInvocation", () => {
  it("uses the npx form when launched through npx", () => {
    assert.equal(cliInvocation({ npm_command: "exec" }), "npx @localbase/cli");
    assert.equal(cliInvocation({}), "localbase");
  });
});
