import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

const testSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localbase-storage-api-"));
}

function makeFile(name: string, content: string, type?: string): File {
  return new File([content], name, { type: type ?? "application/octet-stream" });
}

function makeUploadForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

async function readResponseBody(res: Response): Promise<string> {
  return res.text();
}

describe("Storage REST API", () => {
  let db: Database;
  let app: Hono;
  let tmp: string;

  before(() => {
    tmp = tempDir();
    db = new Database({
      schema: testSchema,
      dataDir: tmp,
    });
    app = createServer(db, testSchema);
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("POST /api/storage/:bucket", () => {
    it("should upload a file and return metadata", async () => {
      const file = makeFile("report.pdf", "hello world", "application/pdf");
      const res = await app.request("/api/storage/documents", {
        method: "POST",
        body: makeUploadForm(file),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 201);
      assert.equal(body.data.originalName, "report.pdf");
      assert.equal(body.data.size, 11);
      assert.equal(body.data.mime, "application/pdf");
      assert.ok(body.data.storedName.length > 0);
      assert.ok(body.data.path.startsWith("documents/"));
    });

    it("should reject requests without a file", async () => {
      const res = await app.request("/api/storage/documents", {
        method: "POST",
        body: new FormData(),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 400);
      assert.ok(body.error);
    });

    it("should reject oversized uploads from createServer storage options", async () => {
      const limitedTmp = tempDir();
      const limitedDb = new Database({
        schema: testSchema,
        dataDir: limitedTmp,
      });
      const limitedApp = createServer(limitedDb, testSchema, {
        storage: { maxFileSize: 5 },
      });

      try {
        const big = makeFile("big.bin", "123456");
        const res = await limitedApp.request("/api/storage/documents", {
          method: "POST",
          body: makeUploadForm(big),
        });

        const { status, body } = await parseJson(res);
        assert.equal(status, 413);
        assert.ok(/exceeds maximum/.test(body.error));
      } finally {
        limitedDb.close();
        fs.rmSync(limitedTmp, { recursive: true, force: true });
      }
    });

    it("should reject invalid bucket names", async () => {
      const file = makeFile("ok.txt", "ok");
      const res = await app.request("/api/storage/BadBucket", {
        method: "POST",
        body: makeUploadForm(file),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 400);
      assert.ok(/Invalid bucket name/.test(body.error));
    });

    it("should reject filenames with header-control characters", async () => {
      const file = makeFile("bad\nname.txt", "ok");
      const res = await app.request("/api/storage/documents", {
        method: "POST",
        body: makeUploadForm(file),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 400);
      assert.ok(/Invalid original filename/.test(body.error));
    });
  });

  describe("GET /api/storage/:bucket/:filename", () => {
    it("should download a file with original name", async () => {
      const file = makeFile("reyansh.jpg", "image bytes", "image/jpeg");
      const upload = await app.request("/api/storage/avatars", {
        method: "POST",
        body: makeUploadForm(file),
      });
      const { data } = (await upload.json()) as { data: { storedName: string } };

      const res = await app.request(
        `/api/storage/avatars/${data.storedName}`
      );

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/jpeg");
      const disposition = res.headers.get("content-disposition");
      assert.ok(disposition);
      assert.ok(disposition.includes('filename="reyansh.jpg"'));

      const body = await readResponseBody(res);
      assert.equal(body, "image bytes");
    });

    it("should return 404 for unknown stored name", async () => {
      const res = await app.request(
        "/api/storage/avatars/00000000-0000-0000-0000-000000000000"
      );

      const { status, body } = await parseJson(res);
      assert.equal(status, 404);
      assert.ok(body.error);
    });

    it("should return 404 for unknown bucket", async () => {
      const res = await app.request(
        "/api/storage/unknown/00000000-0000-0000-0000-000000000000"
      );

      const { status, body } = await parseJson(res);
      assert.equal(status, 404);
      assert.ok(body.error);
    });
  });

  describe("GET /api/storage/:bucket", () => {
    it("should list files in a bucket", async () => {
      await app.request("/api/storage/photos", {
        method: "POST",
        body: makeUploadForm(makeFile("a.png", "a", "image/png")),
      });
      await app.request("/api/storage/photos", {
        method: "POST",
        body: makeUploadForm(makeFile("b.png", "b", "image/png")),
      });

      const res = await app.request("/api/storage/photos");
      const { status, body } = await parseJson(res);

      assert.equal(status, 200);
      assert.equal(body.data.files.length, 2);
      assert.equal(body.data.total, 2);
      assert.ok(body.data.files.every((f: { bucket: string }) => f.bucket === "photos"));
    });

    it("should paginate list results", async () => {
      await app.request("/api/storage/paged", {
        method: "POST",
        body: makeUploadForm(makeFile("1.txt", "1")),
      });
      await app.request("/api/storage/paged", {
        method: "POST",
        body: makeUploadForm(makeFile("2.txt", "2")),
      });
      await app.request("/api/storage/paged", {
        method: "POST",
        body: makeUploadForm(makeFile("3.txt", "3")),
      });

      const res = await app.request("/api/storage/paged?limit=2&offset=0");
      const { status, body } = await parseJson(res);

      assert.equal(status, 200);
      assert.equal(body.data.files.length, 2);
      assert.equal(body.data.total, 3);
    });

    it("should return 400 for invalid pagination", async () => {
      const res = await app.request("/api/storage/photos?limit=abc");
      const { status } = await parseJson(res);
      assert.equal(status, 400);
    });
  });

  describe("DELETE /api/storage/:bucket/:filename", () => {
    it("should delete a file", async () => {
      const file = makeFile("temp.txt", "delete me");
      const upload = await app.request("/api/storage/trash", {
        method: "POST",
        body: makeUploadForm(file),
      });
      const { data } = (await upload.json()) as { data: { storedName: string } };

      const res = await app.request(`/api/storage/trash/${data.storedName}`, {
        method: "DELETE",
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 200);
      assert.equal(body.data.deleted, true);

      const after = await app.request(`/api/storage/trash/${data.storedName}`);
      assert.equal(after.status, 404);
    });

    it("should return 404 for non-existent file", async () => {
      const res = await app.request(
        "/api/storage/trash/00000000-0000-0000-0000-000000000000",
        { method: "DELETE" }
      );

      const { status, body } = await parseJson(res);
      assert.equal(status, 404);
      assert.ok(body.error);
    });
  });

  describe("maxFileSize enforcement", () => {
    it("should reject files larger than the configured limit", async () => {
      const limitedTmp = tempDir();
      const limitedDb = new Database({
        schema: testSchema,
        dataDir: limitedTmp,
      });
      const { createStorageRouter } = await import("./router.js");
      const { Hono } = await import("hono");
      const limitedApp = new Hono();
      limitedApp.route("/", createStorageRouter(limitedDb, { maxFileSize: 5 }));

      try {
        const file = makeFile("too-big.txt", "123456");
        const res = await limitedApp.request("/api/storage/docs", {
          method: "POST",
          body: makeUploadForm(file),
        });

        const { status, body } = await parseJson(res);
        assert.equal(status, 413);
        assert.ok(/exceeds maximum/.test(body.error));
      } finally {
        limitedDb.close();
        fs.rmSync(limitedTmp, { recursive: true, force: true });
      }
    });
  });
});

async function parseJson(res: Response): Promise<{ status: number; body: any }> {
  const body = await res.json();
  return { status: res.status, body };
}
