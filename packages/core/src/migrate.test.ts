import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import type { DatabaseSchema } from "@localbase/shared";
import { runMigrations, getAppliedMigrations } from "./migrate.js";
import {
  columnToAddDDL,
  AdditiveMigrationError,
  topologicalSort,
} from "./ddl.js";

// ─── columnToAddDDL ────────────────────────────────────────────

describe("columnToAddDDL", () => {
  it("emits a valid additive statement for a plain column", () => {
    const ddl = columnToAddDDL("_users", "role", {
      type: "text",
      default: "'user'",
      nullable: false,
    });
    assert.equal(
      ddl,
      `ALTER TABLE "_users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user'`
    );
  });

  it("emits a nullable column without NOT NULL", () => {
    const ddl = columnToAddDDL("tasks", "notes", { type: "text" });
    assert.equal(ddl, `ALTER TABLE "tasks" ADD COLUMN "notes" TEXT`);
  });

  it("maps boolean → INTEGER", () => {
    const ddl = columnToAddDDL("t", "flag", {
      type: "boolean",
      default: "0",
    });
    assert.ok(ddl.includes("INTEGER"));
  });

  it("throws for PRIMARY KEY (cannot add after creation)", () => {
    assert.throws(
      () =>
        columnToAddDDL("t", "id", { type: "integer", primaryKey: true }),
      AdditiveMigrationError
    );
  });

  it("throws for UNIQUE (cannot add after creation)", () => {
    assert.throws(
      () =>
        columnToAddDDL("t", "email", { type: "text", unique: true }),
      AdditiveMigrationError
    );
  });

  it("throws for foreign key (cannot add after creation)", () => {
    assert.throws(
      () =>
        columnToAddDDL("t", "user_id", {
          type: "integer",
          references: { table: "users", column: "id" },
        }),
      AdditiveMigrationError
    );
  });

  it("throws for NOT NULL without a default", () => {
    assert.throws(
      () => columnToAddDDL("t", "c", { type: "text", nullable: false }),
      AdditiveMigrationError
    );
  });
});

// ─── topologicalSort ───────────────────────────────────────────

describe("topologicalSort", () => {
  it("orders referenced tables before referencing tables", () => {
    // Deliberately declared out of dependency order.
    const schema: DatabaseSchema = {
      posts: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        user_id: {
          type: "integer",
          references: { table: "users", column: "id" },
        },
      },
      users: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    };
    const sorted = topologicalSort(schema).map(([name]) => name);
    // users must come before posts even though posts was declared first.
    assert.ok(sorted.indexOf("users") < sorted.indexOf("posts"));
  });
});

// ─── runMigrations — additive column path ──────────────────────

describe("runMigrations — additive columns", () => {
  it("adds a missing column to an existing table without dropping data", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      // v1 schema — table without the new column.
      const v1: DatabaseSchema = {
        _users: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          email: { type: "text", nullable: false, unique: true },
          password_hash: { type: "text", nullable: false },
        },
      };
      runMigrations(db, v1);

      // Insert a real user row that must survive the migration.
      db.prepare(
        `INSERT INTO "_users" ("email", "password_hash") VALUES (?, ?)`
      ).run("existing@test.com", "hashed");

      // v2 schema — add a `role` column. This is the auth upgrade path.
      const v2: DatabaseSchema = {
        _users: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          email: { type: "text", nullable: false, unique: true },
          password_hash: { type: "text", nullable: false },
          role: { type: "text", default: "'user'", nullable: false },
        },
      };
      const applied = runMigrations(db, v2);

      // The new column was added and tracked as a column-level migration.
      assert.ok(applied.includes("_users::role"));

      // Existing data is intact.
      const row = db
        .prepare(`SELECT * FROM "_users" WHERE "email" = ?`)
        .get("existing@test.com") as { email: string; role: string };
      assert.equal(row.email, "existing@test.com");
      // And the default back-fills existing rows.
      assert.equal(row.role, "user");

      // Re-running is idempotent — nothing new applied.
      const reapplied = runMigrations(db, v2);
      assert.equal(reapplied.length, 0);
    } finally {
      db.close();
    }
  });

  it("records column migrations separately from table migrations", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      const v1: DatabaseSchema = {
        t: { id: { type: "integer", primaryKey: true, autoIncrement: true } },
      };
      runMigrations(db, v1);
      const v2: DatabaseSchema = {
        t: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          label: { type: "text" },
        },
      };
      runMigrations(db, v2);

      const applied = getAppliedMigrations(db);
      assert.ok(applied.has("t"));
      assert.ok(applied.has("t::label"));
    } finally {
      db.close();
    }
  });

  it("adds promotion user_id to an existing admin-request table", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      const v1: DatabaseSchema = {
        _admin_requests: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          email: { type: "text", nullable: false, unique: true },
          password_hash: { type: "text", nullable: false },
          created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
        },
      };
      runMigrations(db, v1);
      db.prepare(
        `INSERT INTO "_admin_requests" ("email", "password_hash") VALUES (?, ?)`
      ).run("pending@test.com", "hash");

      const v2: DatabaseSchema = {
        _admin_requests: {
          ...v1._admin_requests,
          user_id: { type: "integer" },
        },
      };
      const applied = runMigrations(db, v2);
      assert.ok(applied.includes("_admin_requests::user_id"));
      const row = db
        .prepare(`SELECT * FROM "_admin_requests" WHERE "email" = ?`)
        .get("pending@test.com") as { user_id: number | null };
      assert.equal(row.user_id, null);
    } finally {
      db.close();
    }
  });

  it("creates brand-new tables in phase 1 and skips phase 2 for them", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      const schema: DatabaseSchema = {
        tasks: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          title: { type: "text", nullable: false },
          done: { type: "boolean", default: "0" },
        },
      };
      const applied = runMigrations(db, schema);
      // A brand-new table is one migration; its columns are not separately
      // recorded because they all came in via CREATE TABLE.
      assert.deepEqual(applied, ["tasks"]);
    } finally {
      db.close();
    }
  });
});
