/**
 * Storage SDK integration tests — M4.
 *
 * Spins up a real auth-enabled server (signed-URL secret = JWT secret) and
 * drives the full `db.storage.from(bucket)` cycle end-to-end:
 *
 *   upload → list → download → remove
 *
 * Plus the signed-URL story: an authenticated client mints a signed URL and a
 * *separate, unauthenticated* client fetches the private file with it.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database, createServer } from "@localbase/core";
import type { DatabaseSchema } from "@localbase/core";
import { serve } from "@hono/node-server";
import { createClient } from "./client.js";
import type { LocalBaseClient } from "./client.js";

const TEST_SECRET = "test-secret-key-32-bytes-or-longer";

const testSchema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
  },
};

let server: ReturnType<typeof serve>;
let db: Database;
let baseUrl: string;
let client: LocalBaseClient;
let tmp: string;

function makeFile(name: string, content: string, type?: string): File {
  return new File([content], name, { type: type ?? "application/octet-stream" });
}

describe("SDK storage", () => {
  before(async () => {
    // Use an isolated temp data dir so the storage engine never writes
    // artifacts into the package directory.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "localbase-sdk-storage-"));
    db = await Database.open({
      schema: testSchema,
      auth: {
        enabled: true,
        jwtSecret: TEST_SECRET,
        accessTokenExpiry: "1h",
        minPasswordLength: 8,
      },
      dataDir: tmp,
      // "public-assets" is public; "private-docs" is undeclared → private.
      buckets: [{ name: "public-assets", public: true }],
    });
    const app = createServer(db, testSchema, {
      auth: { enabled: true, jwtSecret: TEST_SECRET },
    });

    server = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;
    client = createClient(baseUrl);

    // Seed an admin-capable user. Storage writes require auth; role doesn't
    // matter for the public /api/storage/* gate (any valid token works).
    const { error } = await client.auth.signUp({
      email: "reyansh@test.com",
      password: "supersecret",
    });
    if (error) throw new Error(`signup failed: ${error}`);
  });

  after(async () => {
    await db.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("full cycle: upload → list → download → remove", () => {
    it("uploads, lists, downloads by original name, then removes", async () => {
      const bucket = client.storage.from("private-docs");

      // upload
      const up = await bucket.upload(
        makeFile("report.pdf", "hello report", "application/pdf")
      );
      assert.equal(up.error, null);
      assert.ok(up.data);
      assert.equal(up.data!.originalName, "report.pdf");
      assert.equal(up.data!.size, "hello report".length);
      assert.equal(up.data!.mime, "application/pdf");
      assert.ok(up.data!.storedName.length > 0);

      // list (sees the uploaded file)
      const listed = await bucket.list();
      assert.equal(listed.error, null);
      assert.ok(listed.data!.length >= 1);
      const found = listed.data!.find(
        (f) => f.originalName === "report.pdf"
      );
      assert.ok(found, "uploaded file should appear in the list");

      // download by ORIGINAL name (SDK resolves to storedName internally)
      const dl = await bucket.download("report.pdf");
      assert.equal(dl.error, null);
      assert.ok(dl.data);
      assert.equal(await dl.data!.text(), "hello report");

      // remove by ORIGINAL name
      const rm = await bucket.remove("report.pdf");
      assert.equal(rm.error, null);
      assert.equal(rm.data!.deleted, true);

      // gone
      const after = await bucket.list();
      assert.equal(
        after.data!.some((f) => f.originalName === "report.pdf"),
        false
      );
    });

    it("download/remove return a not-found error for unknown names", async () => {
      const bucket = client.storage.from("private-docs");
      const dl = await bucket.download("nope.txt");
      assert.ok(dl.error);

      const rm = await bucket.remove("nope.txt");
      assert.ok(rm.error);
    });
  });

  describe("signed URL fetch from an unauthenticated client", () => {
    it("authenticated client mints a URL; anon client fetches the private file", async () => {
      const bucket = client.storage.from("private-docs");
      const up = await bucket.upload(
        makeFile("secret.png", "secret-bytes", "image/png")
      );
      assert.equal(up.error, null);

      // Mint a signed URL as the authenticated client.
      const signed = await bucket.createSignedUrl(up.data!.originalName, {
        expiresIn: 3600,
      });
      assert.equal(signed.error, null);
      assert.ok(signed.data);
      assert.ok(signed.data!.includes("expires="));
      assert.ok(signed.data!.includes("sig="));

      // A brand-new, never-authenticated client fetches the private file.
      const anon = createClient(baseUrl); // no signIn
      const res = await fetch(signed.data!);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "secret-bytes");
      void anon; // anon never holds a token
    });

    it("a private download WITHOUT auth or a signed URL fails", async () => {
      const bucket = client.storage.from("private-docs");
      const up = await bucket.upload(makeFile("guarded.txt", "g"));
      const storedName = up.data!.storedName;

      const res = await fetch(
        `${baseUrl}/api/storage/private-docs/${storedName}`
      );
      assert.equal(res.status, 401);
    });
  });

  describe("public bucket", () => {
    it("getPublicUrl resolves and is readable without auth", async () => {
      const bucket = client.storage.from("public-assets");
      const up = await bucket.upload(
        makeFile("logo.png", "logo-bytes", "image/png")
      );
      assert.equal(up.error, null);

      const url = await bucket.getPublicUrl(up.data!.originalName, {
        absolute: true,
      });
      assert.equal(url.error, null);
      assert.ok(url.data);

      // No Authorization header — public bucket is open for reads.
      const res = await fetch(url.data!);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "logo-bytes");
    });

    it("writes to a public bucket still require auth", async () => {
      const anon = createClient(baseUrl); // no signIn
      const up = await anon.storage.from("public-assets").upload(
        makeFile("x.txt", "x")
      );
      assert.ok(up.error);
    });
  });
});
