/**
 * M2.5 — Admin API hardening tests.
 *
 * These lock down the dangerous generic admin surface (`/_api/admin/*`) before
 * a React UI is built on top of it. They cover, independent of the UI:
 *
 *   1. Virtual-table write blocking (a confirmed blocker — fts5 tables and
 *      their shadow tables must be read-only).
 *   2. Identifier safety — table/column/sort/filter names are validated and
 *      quoted centrally; a regex-failing name yields a clean 400, never a 500.
 *   3. Insert works on tables without an `id` column (no-PK, composite-PK,
 *      text-PK) — the fetch-by-id bug is fixed.
 *   4. Injection regression guards — classic identifier payloads are rejected
 *      and mutate nothing; SQL in eq/like/in VALUES is bound, not interpolated.
 *   5. Pagination bounds — limit/offset are validated and bounded.
 *
 * Most tests use an UNGATED admin app (`{ admin: { enabled: true } }` with no
 * auth) to isolate the SQL/mutation surface from auth noise. The authz layer
 * itself is covered in `admin-auth.test.ts`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import { count } from "../query.js";
import { AdminError } from "./system-tables.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

// ─── Shared schema + helpers ────────────────────────────────────

const baseSchema: DatabaseSchema = {
  t: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text" },
    age: { type: "integer", nullable: true },
  },
};

const SECRET = "hardening-test-secret";

/** Track open DBs so a failing test can't leak a better-sqlite3 handle. */
const openDbs: Database[] = [];
function track(db: Database): Database {
  openDbs.push(db);
  return db;
}

/** Admin app with auth OFF (ungated) — isolates the SQL/mutation surface. */
function ungatedApp(schema: DatabaseSchema = baseSchema): {
  db: Database;
  app: Hono;
} {
  const db = track(new Database({ schema }));
  const app = createServer(db, schema, {
    admin: { enabled: true },
    auth: { enabled: false },
  });
  return { db, app };
}

async function parseResponse(res: Response) {
  const json = await res.json();
  return { status: res.status, body: json };
}

afterEach(() => {
  while (openDbs.length) openDbs.pop()!.close();
});

/**
 * fts5 is a compile-time option (SQLITE_ENABLE_FTS5). The official
 * better-sqlite3 prebuilds include it, but a musl/source/custom build may not.
 * Probe once and skip the virtual-table tests if it is unavailable, so the
 * suite degrades gracefully instead of hard-crashing on an environment trait.
 */
const HAS_FTS5 = (() => {
  try {
    const probe = new Database({ schema: {} });
    probe.raw().exec("CREATE VIRTUAL TABLE __probe USING fts5(x)");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();
const vtabDescribe = HAS_FTS5 ? describe : describe.skip;

// ─── 1. Virtual-table write blocking ────────────────────────────

vtabDescribe("Virtual-table write blocking (fts5 + shadow tables are read-only)", () => {
  // fts5 is compiled into the better-sqlite3 build this repo ships; if a
  // future build omits it, these setups throw with a clear SQLite error.
  function ftsApp() {
    const { db, app } = ungatedApp({
      dummy: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec("CREATE VIRTUAL TABLE ft USING fts5(content)");
    return { db, app };
  }

  it("POST to an fts5 virtual table is rejected (403) and nothing persists", async () => {
    const { db, app } = ftsApp();
    const res = await app.request("/_api/admin/tables/ft/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "injected" }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 403);
    assert.match(body.error, /virtual|read-only/i);
    const rows = db.raw().prepare('SELECT * FROM "ft"').all();
    assert.equal(rows.length, 0, "no row should have been inserted");
  });

  it("reads on a virtual table still work, but PATCH and DELETE are blocked", async () => {
    const { db, app } = ftsApp();
    db.raw().exec("INSERT INTO ft(content) VALUES ('seed')");

    const get = await app.request("/_api/admin/tables/ft/rows");
    assert.equal(get.status, 200);

    const patch = await app.request("/_api/admin/tables/ft/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(patch.status, 403);

    const del = await app.request("/_api/admin/tables/ft/rows/1", {
      method: "DELETE",
    });
    assert.equal(del.status, 403);

    const rows = db.raw().prepare('SELECT content FROM "ft"').all() as {
      content: string;
    }[];
    assert.deepEqual(rows.map((r) => r.content), ["seed"]);
  });

  it("writes to an fts5 shadow table (ft_content) are rejected", async () => {
    const { db, app } = ftsApp();
    db.raw().exec("INSERT INTO ft(content) VALUES ('seed')"); // ensures shadows exist
    // ft_content backs the index; writing to it would corrupt ft.
    const res = await app.request("/_api/admin/tables/ft_content/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, c0: "corrupt" }),
    });
    assert.equal(res.status, 403);
  });

  it("introspection flags a virtual table and its shadow as virtual: true", () => {
    const { db } = ftsApp();
    db.raw().exec("INSERT INTO ft(content) VALUES ('seed')");
    const schema = db.introspect();
    const find = (name: string) =>
      schema.tables.find((t) => t.name === name);
    assert.equal(find("ft")?.virtual, true);
    assert.equal(find("ft_content")?.virtual, true);
    // an ordinary user table is NOT flagged.
    assert.equal(find("dummy")?.virtual, false);
  });

  it("does NOT over-block a user table sharing a name prefix with a vtab (ft_archive)", async () => {
    // Pins the PRAGMA table_list classification: a real user table named
    // ft_archive must remain writable even when an fts5 table `ft` exists.
    // (A naive name-prefix heuristic would wrongly flag it virtual.)
    const { db, app } = ungatedApp({
      dummy: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec("CREATE VIRTUAL TABLE ft USING fts5(content)");
    db.raw().exec('CREATE TABLE "ft_archive" (id INTEGER PRIMARY KEY, v TEXT)');

    const schema = db.introspect();
    const arch = schema.tables.find((t) => t.name === "ft_archive");
    assert.ok(arch, "ft_archive should be introspected");
    assert.equal(arch!.virtual, false, "ft_archive must not be flagged virtual");

    const res = await app.request("/_api/admin/tables/ft_archive/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: "ok" }),
    });
    assert.equal((await parseResponse(res)).status, 201);
  });
});

// ─── Bucket-3 read-only surfaces: sqlite_%, views, _-prefix, no-PK ──

describe("Read-only surfaces: sqlite_%, views, _-prefixed, no-PK DELETE", () => {
  it("rejects writes to sqlite_% bookkeeping tables (sqlite_sequence, sqlite_master)", async () => {
    const { db, app } = ungatedApp({
      seq: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        v: { type: "text" },
      },
    });
    db.insert("seq", { v: "a" }); // materializes sqlite_sequence
    // Snapshot BEFORE: _migrations (also AUTOINCREMENT) + seq both appear here.
    const beforeSeq = db.raw().prepare("SELECT * FROM sqlite_sequence").all();
    for (const table of ["sqlite_sequence", "sqlite_master"]) {
      const post = await app.request(`/_api/admin/tables/${table}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: 1 }),
      });
      assert.ok(
        [400, 403, 404].includes(post.status),
        `${table} POST returned ${post.status} (expected rejection)`
      );
    }
    // sqlite_sequence must be byte-for-byte unchanged by any attempt, and the
    // `seq` counter row must still be present.
    const afterSeq = db.raw().prepare("SELECT * FROM sqlite_sequence").all();
    assert.deepEqual(afterSeq, beforeSeq, "sqlite_sequence was mutated");
    assert.ok(
      (afterSeq as Array<{ name: string }>).some((r) => r.name === "seq"),
      "seq counter row intact"
    );
  });

  it("rejects writes to SQL VIEWs and leaves the underlying table untouched", async () => {
    const { db, app } = ungatedApp({
      seq: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        v: { type: "text" },
      },
    });
    db.raw().exec("CREATE VIEW v_seq AS SELECT id, v FROM seq");
    db.insert("seq", { v: "first" });

    const post = await app.request("/_api/admin/tables/v_seq/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 99, v: "injected" }),
    });
    assert.ok(
      [400, 403, 404].includes(post.status),
      `view POST returned ${post.status}`
    );
    const del = await app.request("/_api/admin/tables/v_seq/rows/1", {
      method: "DELETE",
    });
    assert.ok([400, 403, 404].includes(del.status));

    const rows = db.raw().prepare('SELECT v FROM "seq"').all() as {
      v: string;
    }[];
    assert.deepEqual(rows.map((r) => r.v), ["first"]);
  });

  it("rejects writes to ANY _-prefixed table (not only _users/_sessions)", async () => {
    const { db, app } = ungatedApp({
      filler: { id: { type: "integer", primaryKey: true, autoIncrement: true } },
    });
    db.raw().exec('CREATE TABLE "_future" (id INTEGER PRIMARY KEY, v TEXT)');
    db.raw().exec("INSERT INTO _future (id, v) VALUES (1, 'orig')");

    const post = await app.request("/_api/admin/tables/_future/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: "x" }),
    });
    assert.equal((await parseResponse(post)).status, 403);
    const patch = await app.request("/_api/admin/tables/_future/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: "y" }),
    });
    assert.equal((await parseResponse(patch)).status, 403);
    const del = await app.request("/_api/admin/tables/_future/rows/1", {
      method: "DELETE",
    });
    assert.equal((await parseResponse(del)).status, 403);

    const row = db.raw().prepare('SELECT v FROM "_future"').get() as {
      v: string;
    };
    assert.equal(row.v, "orig");
  });

  it("DELETE on a no-PK table returns 400 (browse-only, like PATCH)", async () => {
    const { db, app } = ungatedApp({ nopk: { message: { type: "text" } } });
    db.raw().exec("INSERT INTO nopk (message) VALUES ('keep')");
    const del = await app.request("/_api/admin/tables/nopk/rows/1", {
      method: "DELETE",
    });
    assert.equal((await parseResponse(del)).status, 400);
    const rows = db.raw().prepare('SELECT * FROM "nopk"').all();
    assert.equal(rows.length, 1);
  });

  it("count() rejects an injection table name (pins the centralized table-name guard)", () => {
    // If someone reverted db.count() to a hand-rolled `FROM "${table}"`,
    // these identifiers would be interpolated. count() routes the table name
    // through assertSafeTable, independent of the router's earlier gates.
    const db = track(new Database({ schema: baseSchema }));
    assert.throws(() => count(db.raw(), "t; DROP TABLE x", []), AdminError);
    assert.throws(() => count(db.raw(), 't" OR 1=1--', []), AdminError);
  });
});

// ─── 2. Identifier safety (regex-failing names → 400, not 500) ──

describe("Identifier safety: regex-failing names return 400, never 500", () => {
  // A column whose real name fails the safe-identifier regex (created here via
  // raw ALTER). The admin router accepts it by introspect-membership, but the
  // shared query layer's central regex rejects it — and now throws AdminError
  // (400) rather than a plain Error (500).
  function spacedColumnApp() {
    const { db, app } = ungatedApp({
      t: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec('ALTER TABLE "t" ADD COLUMN "a b" TEXT');
    db.raw().exec('INSERT INTO "t" DEFAULT VALUES'); // row id = 1
    return { db, app };
  }

  it("GET filter on a regex-failing column name → 400", async () => {
    const { app } = spacedColumnApp();
    const sp = new URLSearchParams();
    sp.set("a b", "eq.spaced");
    const res = await app.request(`/_api/admin/tables/t/rows?${sp}`);
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("GET ORDER BY a regex-failing column name → 400", async () => {
    const { app } = spacedColumnApp();
    const res = await app.request(
      "/_api/admin/tables/t/rows?order=a%20b.asc"
    );
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
  });

  it("POST body key that is a regex-failing column → 400 and nothing inserted", async () => {
    const { db, app } = spacedColumnApp();
    const res = await app.request("/_api/admin/tables/t/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "a b": "v" }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
    assert.equal(
      (db.raw().prepare('SELECT COUNT(*) AS n FROM "t"').get() as { n: number })
        .n,
      1,
      "no new row"
    );
  });

  it("PATCH body key that is a regex-failing column → 400 and row unchanged", async () => {
    const { db, app } = spacedColumnApp();
    const res = await app.request("/_api/admin/tables/t/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "a b": "updated" }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 400);
    const row = db.raw().prepare('SELECT "a b" AS ab FROM "t"').get() as {
      ab: unknown;
    };
    assert.equal(row.ab, null, "row untouched");
  });

  it("PATCH/DELETE on a table whose PK name fails the regex → 400, not 500", async () => {
    const { db, app } = ungatedApp({
      filler: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec('CREATE TABLE "weird" ("my id" TEXT PRIMARY KEY, val TEXT)');
    db.raw().exec("INSERT INTO weird (\"my id\", val) VALUES ('k1','v1')");

    const patch = await app.request("/_api/admin/tables/weird/rows/k1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ val: "x" }),
    });
    assert.equal((await parseResponse(patch)).status, 400);

    const del = await app.request("/_api/admin/tables/weird/rows/k1", {
      method: "DELETE",
    });
    assert.equal((await parseResponse(del)).status, 400);

    // Nothing changed.
    const row = db.raw().prepare('SELECT val FROM "weird"').get() as {
      val: string;
    };
    assert.equal(row.val, "v1");
  });
});

// ─── 3. Insert works on tables without an `id` column ───────────

describe("Insert works on non-id-PK tables (fetch-by-id fix)", () => {
  it("POST on a no-PK table inserts a row (201)", async () => {
    const { db, app } = ungatedApp({
      nopk: { message: { type: "text" } },
    });
    const res = await app.request("/_api/admin/tables/nopk/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const { status, body } = await parseResponse(res);
    assert.equal(status, 201);
    assert.equal(body.data.message, "hello");
    const rows = db.raw().prepare('SELECT * FROM "nopk"').all();
    assert.equal(rows.length, 1);
  });

  it("POST on a composite-PK table inserts a row (201)", async () => {
    const { db, app } = ungatedApp({
      filler: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec(
      'CREATE TABLE "comp" ("a" INTEGER, "b" INTEGER, "v" TEXT, PRIMARY KEY("a","b"))'
    );
    const res = await app.request("/_api/admin/tables/comp/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 3, b: 4, v: "x" }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 201);
    const row = db.raw().prepare('SELECT * FROM "comp"').get() as {
      a: number;
      b: number;
      v: string;
    };
    assert.deepEqual([row.a, row.b, row.v], [3, 4, "x"]);
  });

  it("POST on a single text-PK table (PK not named id) inserts a row (201)", async () => {
    const { db, app } = ungatedApp({
      textpk: {
        slug: { type: "text", primaryKey: true },
        label: { type: "text" },
      },
    });
    const res = await app.request("/_api/admin/tables/textpk/rows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "s2", label: "second" }),
    });
    const { status } = await parseResponse(res);
    assert.equal(status, 201);
    const row = db.raw().prepare('SELECT * FROM "textpk"').get() as {
      slug: string;
    };
    assert.equal(row.slug, "s2");
  });

  it("composite-PK tables remain browse-only: PATCH/DELETE → 400", async () => {
    const { db, app } = ungatedApp({
      filler: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
      },
    });
    db.raw().exec(
      'CREATE TABLE "comp" ("a" INTEGER, "b" INTEGER, "v" TEXT, PRIMARY KEY("a","b"))'
    );
    db.raw().exec("INSERT INTO comp (\"a\",\"b\",\"v\") VALUES (1,2,'r')");

    const patch = await app.request("/_api/admin/tables/comp/rows/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: "z" }),
    });
    assert.equal((await parseResponse(patch)).status, 400);
    const del = await app.request("/_api/admin/tables/comp/rows/1", {
      method: "DELETE",
    });
    assert.equal((await parseResponse(del)).status, 400);

    // Row untouched.
    const row = db.raw().prepare('SELECT v FROM "comp"').get() as { v: string };
    assert.equal(row.v, "r");
  });

  it("text-PK PATCH/DELETE works (positive control — update() uses RETURNING *)", async () => {
    const { db, app } = ungatedApp({
      textpk: {
        slug: { type: "text", primaryKey: true },
        label: { type: "text" },
      },
    });
    db.raw().exec("INSERT INTO textpk (slug,label) VALUES ('s1','first')");

    const patch = await app.request("/_api/admin/tables/textpk/rows/s1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "updated" }),
    });
    const { status, body } = await parseResponse(patch);
    assert.equal(status, 200);
    assert.equal(body.data.label, "updated");

    const del = await app.request("/_api/admin/tables/textpk/rows/s1", {
      method: "DELETE",
    });
    assert.equal((await parseResponse(del)).status, 200);
    assert.equal(
      (db.raw().prepare('SELECT COUNT(*) AS n FROM "textpk"').get() as {
        n: number;
      }).n,
      0
    );
  });
});

// ─── 4. Injection regression guards ─────────────────────────────

describe("Injection guard: identifier payloads are rejected and mutate nothing", () => {
  it("rejects SQL in filter keys, order columns, path tables, and body keys", async () => {
    const { db, app } = ungatedApp({
      users: {
        id: { type: "integer", primaryKey: true, autoIncrement: true },
        name: { type: "text", nullable: false },
      },
    });
    db.insert("users", { name: "Alice" });
    db.insert("users", { name: "Bob" });

    const enc = (s: string) => encodeURIComponent(s);
    // [label, method, path, allowed statuses]
    // Filter-key and order-column payloads hit the EXISTING users table, so
    // the only correct outcome is 400 (unknown column / bad operator). Path
    // payloads target a non-existent table, so 400 or 404 are both acceptable.
    const cases: Array<[string, string, string, number[]]> = [
      ["filter key ;--", "GET", `/_api/admin/tables/users/rows?${enc("name;DROP TABLE users--")}=eq.1`, [400]],
      ["filter key quote", "GET", `/_api/admin/tables/users/rows?${enc('name"="x')}=eq.1`, [400]],
      ["order ;--", "GET", "/_api/admin/tables/users/rows?order=name;DROP TABLE users--", [400]],
      ["order CASE", "GET", "/_api/admin/tables/users/rows?order=(CASE WHEN 1 THEN name ELSE id END).desc", [400]],
      ["order bad col", "GET", "/_api/admin/tables/users/rows?order=bogus.asc", [400]],
      ["order uppercase dir", "GET", "/_api/admin/tables/users/rows?order=name.DESC", [400]],
      ["path ;--", "GET", `/_api/admin/tables/${enc("users;DROP TABLE x")}/rows`, [400, 404]],
      ["path union", "GET", `/_api/admin/tables/${enc("union")}/rows`, [400, 404]],
    ];
    for (const [, method, path, allowed] of cases) {
      const res = await app.request(path, { method });
      assert.ok(
        allowed.includes(res.status),
        `${method} ${path} returned ${res.status} (expected ${allowed})`
      );
    }
    // body key injection
    const bodyCases = [
      { 'name) VALUES(1)--': 1 },
      { 'name;x': 1 },
    ];
    for (const bodyKey of bodyCases) {
      const res = await app.request("/_api/admin/tables/users/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyKey),
      });
      assert.ok(
        res.status === 400,
        `POST with body key ${JSON.stringify(bodyKey)} returned ${res.status}`
      );
    }

    // Post-batch invariant: users intact, nothing dropped/created.
    const userCount = (
      db.raw().prepare('SELECT COUNT(*) AS n FROM "users"').get() as {
        n: number;
      }
    ).n;
    assert.equal(userCount, 2);
    const tables = (
      db
        .raw()
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes("users"), "users table still exists");
    assert.ok(
      !tables.some((n) => n.toLowerCase().includes("hacked")),
      "no injected table created"
    );
  });
});

describe("Injection guard: SQL in eq/like/in VALUES is bound, not interpolated", () => {
  it("binds SQL payloads as values — tautologies cannot escape, hashes never leak", async () => {
    // Auth-enabled DB so _users exists with a recognizable planted hash, but
    // the SERVER is mounted ungated so we test the query layer directly.
    const db = track(
      new Database({
        schema: baseSchema,
        auth: { enabled: true, jwtSecret: SECRET },
      })
    );
    db.insert("_users", {
      email: "leak@x.com",
      password_hash: "LEAK_HASH_xyz",
      role: "user",
    });
    db.insert("t", { name: "alice" }); // id 1
    db.insert("t", { name: "bob" }); // id 2
    const app = createServer(db, baseSchema, {
      admin: { enabled: true },
      auth: { enabled: false },
    });

    const build = (params: Record<string, string>) =>
      `/_api/admin/tables/t/rows?${new URLSearchParams(params)}`;

    // The returned ROW COUNT is what proves binding. Each value-payload here
    // matches ZERO rows when bound as a parameter — but if the value were
    // string-interpolated into the SQL, the tautology would return ALL rows
    // (2). Asserting the count makes the defense load-bearing; a bare "no
    // leak / no 500" check would pass under a vulnerable implementation too.
    const cases: Array<[Record<string, string>, number, string]> = [
      [{ name: "eq.' OR '1'='1" }, 0, "eq tautology"],
      [{ name: "like.%'OR 1=1--" }, 0, "like with OR 1=1"],
      [{ id: "in.9) OR 1=1--" }, 0, "in: OR 1=1 cannot escape the bound list"],
      [
        { id: "in.1,2,3) OR 1=1--" },
        2,
        "in list: only id 1,2 exist (trailing SQL junk is a bound element, not SQL)",
      ],
    ];

    for (const [params, expected, label] of cases) {
      const res = await app.request(build(params));
      const { status, body } = await parseResponse(res);
      assert.equal(status, 200, `${label}: expected 200`);
      assert.equal(
        body.data.rows.length,
        expected,
        `${label}: expected ${expected} rows (bound), got ${body.data.rows.length}`
      );
      assert.ok(
        !JSON.stringify(body).includes("LEAK_HASH_xyz"),
        `${label}: password hash leaked`
      );
    }

    // _users untouched (no UNION reached it).
    const hash = (
      db
        .raw()
        .prepare('SELECT password_hash FROM "_users" WHERE email = ?')
        .get("leak@x.com") as { password_hash: string }
    ).password_hash;
    assert.equal(hash, "LEAK_HASH_xyz");
  });
});

// ─── 5. Pagination bounds ───────────────────────────────────────

describe("Pagination bounds (limit/offset validation)", () => {
  function seeded() {
    const { app } = ungatedApp(baseSchema);
    return { app };
  }

  it("rejects limit > 1000, negative, and non-integer limits", async () => {
    const { app } = seeded();
    // Need a separate seeded DB per request (afterEach closes them), so build
    // a fresh app inline for the limit=0 total check below.
    for (const limit of ["1001", "-5", "1.5", "abc", "NaN", "Infinity"]) {
      const res = await app.request(
        `/_api/admin/tables/t/rows?limit=${encodeURIComponent(limit)}`
      );
      assert.equal(
        (await parseResponse(res)).status,
        400,
        `limit=${limit} should be 400`
      );
    }
  });

  it("limit=0 returns an empty page with the correct total", async () => {
    const db = track(new Database({ schema: baseSchema }));
    db.insert("t", { name: "a" });
    db.insert("t", { name: "b" });
    db.insert("t", { name: "c" });
    const app = createServer(db, baseSchema, {
      admin: { enabled: true },
      auth: { enabled: false },
    });
    const res = await app.request("/_api/admin/tables/t/rows?limit=0");
    const { status, body } = await parseResponse(res);
    assert.equal(status, 200);
    assert.deepEqual(body.data.rows, []);
    assert.equal(body.data.total, 3);
  });

  it("limit=2&offset=1 returns the correct page; limit=1000 is allowed", async () => {
    const db = track(new Database({ schema: baseSchema }));
    db.insert("t", { name: "a" });
    db.insert("t", { name: "b" });
    db.insert("t", { name: "c" });
    const app = createServer(db, baseSchema, {
      admin: { enabled: true },
      auth: { enabled: false },
    });

    const page = await app.request(
      "/_api/admin/tables/t/rows?limit=2&offset=1&order=id.asc"
    );
    const pageBody = await parseResponse(page);
    assert.equal(pageBody.status, 200);
    assert.equal(pageBody.body.data.rows.length, 2);
    // Pin WHICH rows: if OFFSET were dropped (a common regression), the
    // response would be a,b — still length 2, but the wrong page.
    assert.deepEqual(
      pageBody.body.data.rows.map((r: { name: string }) => r.name),
      ["b", "c"],
      "offset must skip the first row, not silently return page 0"
    );
    assert.equal(pageBody.body.data.total, 3);

    const boundary = await app.request("/_api/admin/tables/t/rows?limit=1000");
    assert.equal((await parseResponse(boundary)).status, 200);
  });

  it("offset beyond the row count returns an empty page with correct total; negative offset → 400", async () => {
    const db = track(new Database({ schema: baseSchema }));
    db.insert("t", { name: "a" });
    db.insert("t", { name: "b" });
    const app = createServer(db, baseSchema, {
      admin: { enabled: true },
      auth: { enabled: false },
    });

    const beyond = await app.request("/_api/admin/tables/t/rows?limit=5&offset=999");
    const beyondBody = await parseResponse(beyond);
    assert.equal(beyondBody.status, 200);
    assert.deepEqual(beyondBody.body.data.rows, []);
    assert.equal(beyondBody.body.data.total, 2);

    const neg = await app.request("/_api/admin/tables/t/rows?limit=5&offset=-1");
    assert.equal((await parseResponse(neg)).status, 400);
  });
});
