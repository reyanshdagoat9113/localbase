/**
 * M6 — Static bundle tests.
 *
 * These tests are the JS-side counterpart to
 * `scripts/verify-admin-bundle.mjs`. The shell script does the full
 * build + `npm pack --dry-run` end-to-end (it's the publish-time gate);
 * this file runs the smaller, faster checks that the rest of the test
 * suite needs to pass:
 *
 *   1. After a build, the workspace `<core>/dist/admin/index.html` exists.
 *   2. The bundled `index.html` references the same hashed assets the
 *      static mount will serve.
 *   3. The static mount serves a real bundle (not the placeholder) when
 *      the workspace bundle is visible.
 *   4. The static mount serves the hashed JS asset with the correct
 *      content-type.
 *   5. SPA fallback works: `/admin/tables/users` → `index.html`.
 *
 * The tests do NOT rebuild — they assume the workspace has been built
 * (the root `npm run build` is what CI runs first). The full rebuild
 * test lives in `scripts/verify-admin-bundle.mjs`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CORE_DIST_ADMIN = path.join(REPO_ROOT, "packages", "core", "dist", "admin");
const ADMIN_DIST = path.join(REPO_ROOT, "packages", "admin", "dist");

const testSchema: DatabaseSchema = {
  tasks: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
    done: { type: "boolean", default: "0" },
  },
};

function distExists(): boolean {
  return (
    fs.existsSync(path.join(CORE_DIST_ADMIN, "index.html")) &&
    fs.existsSync(path.join(CORE_DIST_ADMIN, "assets"))
  );
}

function workspaceBundleExists(): boolean {
  return (
    fs.existsSync(path.join(ADMIN_DIST, "index.html")) &&
    fs.existsSync(path.join(ADMIN_DIST, "assets"))
  );
}

/**
 * `describe.skip` lets the rest of the suite still run if the bundle
 * isn't present (e.g. a fresh checkout that hasn't been built). The
 * shell-side `verify-admin-bundle.mjs` is the real publish gate; this
 * is a faster in-test sanity check.
 */
const describeIfBundle = distExists() ? describe : describe.skip;
const describeIfWorkspace = workspaceBundleExists() ? describe : describe.skip;

// ─── 1. Build artifact exists ──────────────────────────────────

describeIfBundle("M6 — admin SPA build artifacts", () => {
  it("dist/admin/index.html is present", () => {
    assert.ok(
      fs.existsSync(path.join(CORE_DIST_ADMIN, "index.html")),
      "core build must include dist/admin/index.html"
    );
  });

  it("dist/admin/assets/ contains JS and CSS chunks", () => {
    const assets = path.join(CORE_DIST_ADMIN, "assets");
    const files = fs.readdirSync(assets);
    const js = files.filter((f) => f.endsWith(".js") && !f.endsWith(".map"));
    const css = files.filter((f) => f.endsWith(".css"));
    assert.ok(js.length > 0, "expected at least one JS chunk in dist/admin/assets/");
    assert.ok(css.length > 0, "expected at least one CSS chunk in dist/admin/assets/");
  });

  it("dist/admin/index.html references the bundled assets", () => {
    const html = fs.readFileSync(
      path.join(CORE_DIST_ADMIN, "index.html"),
      "utf8"
    );
    // Vite's emitted index.html uses absolute paths starting with `/` in
    // the `base: "/admin/"` config, so the script src is `/admin/assets/...`.
    assert.match(html, /<script[^>]*src="\/admin\/assets\/index-[^"]+\.js"/);
    assert.match(html, /<link[^>]*href="\/admin\/assets\/index-[^"]+\.css"/);
  });
});

// ─── 2. Static mount serves the real bundle ────────────────────

describeIfWorkspace("M6 — static mount serves the bundled SPA", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    // Force the static mount to use the workspace bundle, regardless of
    // whether the embedded bundle is in place. This lets the test be
    // diagnostic even when the postbuild copy hasn't run yet.
    process.env.LOCALBASE_ADMIN_DIST = ADMIN_DIST;
    app = createServer(db, testSchema, { admin: { enabled: true } });
  });

  after(() => {
    db.close();
    delete process.env.LOCALBASE_ADMIN_DIST;
  });

  it("GET /admin returns the real bundle's index.html (not the placeholder)", async () => {
    const res = await app.request("/admin");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<div id="root"><\/div>/);
    assert.match(text, /<script[^>]*src="\/admin\/assets\//);
    // The placeholder has a green "M1 · placeholder" pill — make sure
    // that's gone, i.e. we're really serving the built bundle.
    assert.doesNotMatch(text, /M1 · placeholder/);
  });

  it("GET /admin/assets/index-*.js serves the JS bundle with text/javascript", async () => {
    // The actual hashed name depends on the current build. Read the
    // emitted index.html to discover it rather than hardcoding.
    const html = fs.readFileSync(
      path.join(ADMIN_DIST, "index.html"),
      "utf8"
    );
    const m = html.match(/<script[^>]*src="\/admin\/assets\/(index-[^"]+\.js)"/);
    assert.ok(m, "could not find the hashed JS filename in index.html");
    const assetPath = `/admin/assets/${m[1]}`;

    const res = await app.request(assetPath);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.match(
      contentType,
      /javascript/,
      `expected text/javascript, got: ${contentType}`
    );
  });

  it("GET /admin/some/nested/path returns the SPA shell (SPA fallback)", async () => {
    const res = await app.request("/admin/tables/users");
    assert.equal(res.status, 200);
    const text = await res.text();
    // The SPA shell is the real bundle's index.html, which contains the
    // React root + script tags.
    assert.match(text, /<div id="root"><\/div>/);
  });

  it("GET /admin/assets/missing-chunk.js returns 404 (not SPA fallback)", async () => {
    const res = await app.request("/admin/assets/this-does-not-exist.js");
    assert.equal(res.status, 404);
  });
});

// ─── 3. End-to-end admin flow (M6 deliverable) ─────────────────

/**
 * "Integration tests: load admin, list tables, edit a row, delete a row."
 *
 * This is the M6 deliverable in plan order. We exercise the full path
 * the React SPA takes when a user clicks around the dashboard:
 *
 *   1. The browser hits `/admin/` and gets the SPA shell.
 *   2. The SPA fetches `/_api/admin/tables` to populate the sidebar.
 *   3. The SPA fetches `/_api/admin/tables/:t/rows` to populate the
 *      data grid.
 *   4. The SPA PATCHes a row when the user edits a cell.
 *   5. The SPA DELETEs a row when the user clicks the trash icon.
 *
 * Tests run ungated (no auth) so they don't need to mint a JWT; the
 * gating surface is fully covered by admin-auth.test.ts. The point
 * here is the full end-to-end glue, not auth.
 */

describeIfBundle("M6 — end-to-end admin flow (load → list → edit → delete)", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    // Same harness as the static-mount tests: point the static mount
    // at the workspace bundle so the SPA shell is served even when the
    // postbuild copy hasn't run yet. The flow tests below are about
    // the API, not the static serving — the static-bundle test above
    // is the one that locks the mount behavior down.
    process.env.LOCALBASE_ADMIN_DIST = ADMIN_DIST;
    db = new Database({ schema: testSchema });
    db.insert("tasks", [
      { title: "First task", done: 0 },
      { title: "Second task", done: 0 },
      { title: "Done task", done: 1 },
    ]);
    app = createServer(db, testSchema, { admin: { enabled: true } });
  });

  after(() => {
    db.close();
    delete process.env.LOCALBASE_ADMIN_DIST;
  });

  it("loads the admin SPA shell at /admin/", async () => {
    const res = await app.request("/admin/");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /<div id="root"><\/div>/);
  });

  it("lists tables via /_api/admin/tables (the SPA's sidebar source)", async () => {
    const res = await app.request("/_api/admin/tables");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data), "expected body.data to be an array");
    const names = body.data.map((t: { name: string }) => t.name);
    assert.ok(
      names.includes("tasks"),
      "tables endpoint should include the user table"
    );
    // The introspected table has a row count — the sidebar shows this
    // next to each table name.
    const tasks = body.data.find(
      (t: { name: string; rowCount: number }) => t.name === "tasks"
    );
    assert.equal(tasks.rowCount, 3);
  });

  it("lists rows via /_api/admin/tables/tasks/rows (the grid's source)", async () => {
    const res = await app.request("/_api/admin/tables/tasks/rows");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data, "expected body.data");
    assert.equal(body.data.total, 3);
    assert.equal(body.data.rows.length, 3);
    // Sort by id asc so the assertion is deterministic regardless of
    // the order SQLite hands us rows back.
    const titles = body.data.rows
      .map((r: { title: string }) => r.title)
      .sort();
    assert.deepEqual(titles, ["Done task", "First task", "Second task"]);
  });

  it("edits a row via PATCH /_api/admin/tables/tasks/rows/:id", async () => {
    const listRes = await app.request("/_api/admin/tables/tasks/rows");
    const listBody = await listRes.json();
    const target = listBody.data.rows[0];

    const res = await app.request(
      `/_api/admin/tables/tasks/rows/${target.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Edited from integration test" }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data, "expected body.data");
    assert.equal(body.data.title, "Edited from integration test");

    // Confirm the change is visible to subsequent reads — the SPA's
    // optimistic update should reconcile to this state.
    const verifyRes = await app.request("/_api/admin/tables/tasks/rows");
    const verifyBody = await verifyRes.json();
    const edited = verifyBody.data.rows.find(
      (r: { id: number }) => r.id === target.id
    );
    assert.equal(edited.title, "Edited from integration test");
  });

  it("deletes a row via DELETE /_api/admin/tables/tasks/rows/:id", async () => {
    const listRes = await app.request("/_api/admin/tables/tasks/rows");
    const listBody = await listRes.json();
    const before = listBody.data.rows.length;
    const target = listBody.data.rows[0];

    const res = await app.request(
      `/_api/admin/tables/tasks/rows/${target.id}`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data, "expected body.data");
    assert.equal(body.data.deleted, true);

    // Confirm the row is gone.
    const verifyRes = await app.request("/_api/admin/tables/tasks/rows");
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.data.total, before - 1);
    const stillThere = verifyBody.data.rows.find(
      (r: { id: number }) => r.id === target.id
    );
    assert.equal(stillThere, undefined);
  });

  it("emits a 'change' event when rows are edited (realtime handoff)", async () => {
    // The whole point of routing admin writes through `Database` is
    // that realtime subscribers see admin edits live. This test
    // exercises that contract: an edit through the admin endpoint
    // must produce a Database 'change' event.
    let changeTable: string | null = null;
    let changeType: string | null = null;
    const handler = (event: { type: string; table: string }) => {
      changeTable = event.table;
      changeType = event.type;
    };
    db.on("change", handler);
    try {
      const res = await app.request(
        "/_api/admin/tables/tasks/rows/9999",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "noop" }),
        }
      );
      // The row id 9999 doesn't exist, so this should 404. But we
      // still want to confirm the event surface is wired: an
      // *existing* row's edit will emit. Use a real id below.
      assert.equal(res.status, 404);

      const listRes = await app.request("/_api/admin/tables/tasks/rows");
      const listBody = await listRes.json();
      const target = listBody.data.rows[0];

      const ok = await app.request(
        `/_api/admin/tables/tasks/rows/${target.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Realtime handoff test" }),
        }
      );
      assert.equal(ok.status, 200);

      assert.equal(changeTable, "tasks", "change event should target tasks");
      assert.equal(changeType, "update", "change event should be an update");
    } finally {
      db.off("change", handler);
    }
  });
});
