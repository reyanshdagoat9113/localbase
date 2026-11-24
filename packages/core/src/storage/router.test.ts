import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../db.js";
import { createServer } from "../api.js";
import { Auth } from "../auth/index.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

const TEST_SECRET = "test-secret-key-32-bytes-or-longer";

const authConfig = {
  enabled: true,
  jwtSecret: TEST_SECRET,
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
} as const;

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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readResponseBody(res: Response): Promise<string> {
  return res.text();
}

describe("Storage REST API", () => {
  let db: Database;
  let app: Hono;
  let tmp: string;
  let token: string;

  before(async () => {
    tmp = tempDir();
    db = await Database.open({
      schema: testSchema,
      auth: authConfig,
      dataDir: tmp,
    });
    app = createServer(db, testSchema, { auth: authConfig });
    const auth = new Auth(db, {
      jwtSecret: TEST_SECRET,
      accessTokenExpiry: "1h",
      refreshTokenExpirySeconds: 86400,
      minPasswordLength: 8,
    });
    const session = await auth.signUp({
      email: "storage-router@test.com",
      password: "supersecret",
    });
    token = session.accessToken;
  });

  after(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("POST /api/storage/:bucket", () => {
    it("should upload a file and return metadata", async () => {
      const file = makeFile("report.pdf", "hello world", "application/pdf");
      const res = await app.request("/api/storage/documents", {
        method: "POST",
        headers: authHeaders(token),
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
        headers: authHeaders(token),
        body: new FormData(),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 400);
      assert.ok(body.error);
    });

    it("should reject oversized uploads from createServer storage options", async () => {
      const limitedTmp = tempDir();
      const limitedDb = await Database.open({
        schema: testSchema,
        auth: authConfig,
        dataDir: limitedTmp,
      });
      const limitedApp = createServer(limitedDb, testSchema, {
        auth: authConfig,
        storage: { maxFileSize: 5 },
      });
      const limitedAuth = new Auth(limitedDb, {
        jwtSecret: TEST_SECRET,
        accessTokenExpiry: "1h",
        refreshTokenExpirySeconds: 86400,
        minPasswordLength: 8,
      });
      const limitedSession = await limitedAuth.signUp({
        email: "limited-router@test.com",
        password: "supersecret",
      });

      try {
        const big = makeFile("big.bin", "123456");
        const res = await limitedApp.request("/api/storage/documents", {
          method: "POST",
          headers: authHeaders(limitedSession.accessToken),
          body: makeUploadForm(big),
        });

        const { status, body } = await parseJson(res);
        assert.equal(status, 413);
        assert.ok(/exceeds maximum/.test(body.error));
      } finally {
        await limitedDb.close();
        fs.rmSync(limitedTmp, { recursive: true, force: true });
      }
    });

    it("should reject invalid bucket names", async () => {
      const file = makeFile("ok.txt", "ok");
      const res = await app.request("/api/storage/BadBucket", {
        method: "POST",
        headers: authHeaders(token),
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
        headers: authHeaders(token),
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
        headers: authHeaders(token),
        body: makeUploadForm(file),
      });
      const { data } = (await upload.json()) as { data: { storedName: string } };

      const res = await app.request(
        `/api/storage/avatars/${data.storedName}`,
        { headers: authHeaders(token) }
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
        "/api/storage/avatars/00000000-0000-0000-0000-000000000000",
        { headers: authHeaders(token) }
      );

      const { status, body } = await parseJson(res);
      assert.equal(status, 404);
      assert.ok(body.error);
    });

    it("should return 404 for unknown bucket", async () => {
      const res = await app.request(
        "/api/storage/unknown/00000000-0000-0000-0000-000000000000",
        { headers: authHeaders(token) }
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
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("a.png", "a", "image/png")),
      });
      await app.request("/api/storage/photos", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("b.png", "b", "image/png")),
      });

      const res = await app.request("/api/storage/photos", {
        headers: authHeaders(token),
      });
      const { status, body } = await parseJson(res);

      assert.equal(status, 200);
      assert.equal(body.data.files.length, 2);
      assert.equal(body.data.total, 2);
      assert.ok(body.data.files.every((f: { bucket: string }) => f.bucket === "photos"));
    });

    it("should paginate list results", async () => {
      await app.request("/api/storage/paged", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("1.txt", "1")),
      });
      await app.request("/api/storage/paged", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("2.txt", "2")),
      });
      await app.request("/api/storage/paged", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("3.txt", "3")),
      });

      const res = await app.request("/api/storage/paged?limit=2&offset=0", {
        headers: authHeaders(token),
      });
      const { status, body } = await parseJson(res);

      assert.equal(status, 200);
      assert.equal(body.data.files.length, 2);
      assert.equal(body.data.total, 3);
    });

    it("should return 400 for invalid pagination", async () => {
      const res = await app.request("/api/storage/photos?limit=abc", {
        headers: authHeaders(token),
      });
      const { status } = await parseJson(res);
      assert.equal(status, 400);
    });
  });

  describe("DELETE /api/storage/:bucket/:filename", () => {
    it("should delete a file", async () => {
      const file = makeFile("temp.txt", "delete me");
      const upload = await app.request("/api/storage/trash", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(file),
      });
      const { data } = (await upload.json()) as { data: { storedName: string } };

      const res = await app.request(`/api/storage/trash/${data.storedName}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });

      const { status, body } = await parseJson(res);
      assert.equal(status, 200);
      assert.equal(body.data.deleted, true);

      const after = await app.request(`/api/storage/trash/${data.storedName}`, {
        headers: authHeaders(token),
      });
      assert.equal(after.status, 404);
    });

    it("should return 404 for non-existent file", async () => {
      const res = await app.request(
        "/api/storage/trash/00000000-0000-0000-0000-000000000000",
        { method: "DELETE", headers: authHeaders(token) }
      );

      const { status, body } = await parseJson(res);
      assert.equal(status, 404);
      assert.ok(body.error);
    });
  });

  describe("maxFileSize enforcement", () => {
    it("should reject files larger than the configured limit", async () => {
      const limitedTmp = tempDir();
      const limitedDb = await Database.open({
        schema: testSchema,
        auth: authConfig,
        dataDir: limitedTmp,
      });
      const limitedAuth = new Auth(limitedDb, {
        jwtSecret: TEST_SECRET,
        accessTokenExpiry: "1h",
        refreshTokenExpirySeconds: 86400,
        minPasswordLength: 8,
      });
      const limitedSession = await limitedAuth.signUp({
        email: "limited-direct@test.com",
        password: "supersecret",
      });
      const { createStorageRouter } = await import("./router.js");
      const { Hono } = await import("hono");
      const limitedApp = new Hono();
      limitedApp.route(
        "/",
        createStorageRouter(limitedDb, {
          authSecret: TEST_SECRET,
          maxFileSize: 5,
        })
      );

      try {
        const file = makeFile("too-big.txt", "123456");
        const res = await limitedApp.request("/api/storage/docs", {
          method: "POST",
          headers: authHeaders(limitedSession.accessToken),
          body: makeUploadForm(file),
        });

        const { status, body } = await parseJson(res);
        assert.equal(status, 413);
        assert.ok(/exceeds maximum/.test(body.error));
      } finally {
        await limitedDb.close();
        fs.rmSync(limitedTmp, { recursive: true, force: true });
      }
    });
  });

  describe("POST /api/storage/:bucket/:filename/sign — FD safety & trustProxy", () => {
    it("checks existence without opening a read stream and allows immediate DELETE", async () => {
      const upload = await app.request("/api/storage/sign-fd", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("doc.txt", "hello world")),
      });
      const { data: uploaded } = (await upload.json()) as {
        data: { storedName: string };
      };

      const origGet = db.storage.get.bind(db.storage);
      let getCalled = false;
      db.storage.get = (...args) => {
        getCalled = true;
        return origGet(...args);
      };
      try {
        const signRes = await app.request(
          `/api/storage/sign-fd/${uploaded.storedName}/sign`,
          {
            method: "POST",
            headers: { ...authHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify({ expiresIn: 60 }),
          }
        );
        assert.equal(signRes.status, 200);
        assert.equal(getCalled, false, "/sign must not call storage.get() / open a stream");
      } finally {
        db.storage.get = origGet;
      }

      // Immediate DELETE must succeed cleanly (no leaked open file descriptor).
      const delRes = await app.request(
        `/api/storage/sign-fd/${uploaded.storedName}`,
        { method: "DELETE", headers: authHeaders(token) }
      );
      assert.equal(delRes.status, 200);
    });

    it("ignores X-Forwarded-Host/Proto by default and honors them when trustProxy is true", async () => {
      const upload = await app.request("/api/storage/sign-proxy", {
        method: "POST",
        headers: authHeaders(token),
        body: makeUploadForm(makeFile("proxy.txt", "data")),
      });
      const { data: uploaded } = (await upload.json()) as {
        data: { storedName: string };
      };

      // Default app has trustProxy: false → ignores spoofed forwarding headers.
      const defaultRes = await app.request(
        `http://localhost:5180/api/storage/sign-proxy/${uploaded.storedName}/sign`,
        {
          method: "POST",
          headers: {
            ...authHeaders(token),
            "Content-Type": "application/json",
            "X-Forwarded-Host": "evil.example.com",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({ expiresIn: 60 }),
        }
      );
      assert.equal(defaultRes.status, 200);
      const defaultBody = (await defaultRes.json()) as {
        data: { signedUrl: string };
      };
      assert.ok(
        defaultBody.data.signedUrl.startsWith("http://localhost:5180/api/storage/"),
        `expected request origin, got ${defaultBody.data.signedUrl}`
      );

      // With trustProxy: true → honors X-Forwarded-Host/Proto.
      const trustedApp = createServer(db, testSchema, {
        auth: authConfig,
        security: { trustProxy: true },
      });
      const trustedRes = await trustedApp.request(
        `http://localhost:5180/api/storage/sign-proxy/${uploaded.storedName}/sign`,
        {
          method: "POST",
          headers: {
            ...authHeaders(token),
            "Content-Type": "application/json",
            "X-Forwarded-Host": "cdn.example.com",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({ expiresIn: 60 }),
        }
      );
      assert.equal(trustedRes.status, 200);
      const trustedBody = (await trustedRes.json()) as {
        data: { signedUrl: string };
      };
      assert.ok(
        trustedBody.data.signedUrl.startsWith("https://cdn.example.com/api/storage/"),
        `expected forwarded origin, got ${trustedBody.data.signedUrl}`
      );
    });
  });
});

async function parseJson(res: Response): Promise<{ status: number; body: any }> {
  const body = await res.json();
  return { status: res.status, body };
}
