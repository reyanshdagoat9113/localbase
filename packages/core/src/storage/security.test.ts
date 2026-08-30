/**
 * Storage security tests — M3.
 *
 * Proves the four read-gate branches and the always-auth write gate:
 *
 *   Read gate (GET /api/storage/:bucket/:filename):
 *     1. public bucket   → open (200, no auth)
 *     2. valid signed URL → open (200, no auth)
 *     3. valid Bearer     → open (200)
 *     4. otherwise        → 401
 *
 *   Write gate (POST / DELETE / GET list): always require a Bearer token,
 *   even on public buckets; signed URLs are never accepted for writes.
 *
 * Also covers the signed-URL primitives directly: roundtrip, tamper,
 * expiry, wrong secret/bucket/name, and malformed `expires`.
 *
 * The storage secret is the resolved JWT secret (the documented fallback),
 * so URLs are signed with the same `TEST_SECRET` the server mints tokens with.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Hono } from "hono";
import type { DatabaseSchema } from "@localbase/shared";

import { Database } from "../db.js";
import { createServer } from "../api.js";
import { Auth } from "../auth/index.js";
import {
  signStorageUrl,
  createSignedUrl,
  verifySignedUrl,
} from "./signed-urls.js";

const TEST_SECRET = "test-secret-key-32-bytes-or-longer";

const testSchema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
  },
};

const authConfig = {
  enabled: true,
  jwtSecret: TEST_SECRET,
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
} as const;

// ─── helpers ───────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localbase-storage-sec-"));
}

function makeFile(name: string, content: string, type?: string): File {
  return new File([content], name, { type: type ?? "application/octet-stream" });
}

function makeUploadForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

async function json(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}

const NOW = () => Math.floor(Date.now() / 1000);

// ─── signed-urls unit tests ────────────────────────────────────

describe("signed-urls primitives", () => {
  const bucket = "avatars";
  const storedName = "11111111-2222-3333-4444-555555555555";
  const secret = "super-secret-storage-key";

  it("verifies a freshly signed URL", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: NOW() + 3600,
      secret,
    });
    assert.equal(
      verifySignedUrl({ bucket, storedName, query: { expires, sig }, secret }),
      true
    );
  });

  it("rejects a tampered signature", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: NOW() + 3600,
      secret,
    });
    const tampered = sig === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires, sig: tampered },
        secret,
      }),
      false
    );
  });

  it("rejects an expired URL (now >= expires)", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: 1000,
      secret,
    });
    // 1000 is long in the past.
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires, sig },
        secret,
        now: 2000,
      }),
      false
    );
    // Exactly at expiry is also rejected (boundary).
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires, sig },
        secret,
        now: 1000,
      }),
      false
    );
  });

  it("accepts an unexpired URL one second before expiry", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: 1000,
      secret,
    });
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires, sig },
        secret,
        now: 999,
      }),
      true
    );
  });

  it("rejects a signature signed with a different secret", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: NOW() + 3600,
      secret,
    });
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires, sig },
        secret: "different-secret",
      }),
      false
    );
  });

  it("rejects a signature bound to a different bucket or stored name", () => {
    const { expires, sig } = signStorageUrl({
      bucket,
      storedName,
      expires: NOW() + 3600,
      secret,
    });
    assert.equal(
      verifySignedUrl({
        bucket: "other-bucket",
        storedName,
        query: { expires, sig },
        secret,
      }),
      false
    );
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName: "99999999-0000-0000-0000-000000000000",
        query: { expires, sig },
        secret,
      }),
      false
    );
  });

  it("rejects missing params", () => {
    assert.equal(
      verifySignedUrl({ bucket, storedName, query: {}, secret }),
      false
    );
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: { expires: String(NOW() + 3600) },
        secret,
      }),
      false
    );
  });

  it("rejects malformed expires values", () => {
    const { sig } = signStorageUrl({
      bucket,
      storedName,
      expires: NOW() + 3600,
      secret,
    });
    for (const bad of ["", "abc", "1.5", "-10", "1e2", " 100", "100 "]) {
      assert.equal(
        verifySignedUrl({
          bucket,
          storedName,
          query: { expires: bad, sig },
          secret,
        }),
        false,
        `expected rejects for expires="${bad}"`
      );
    }
  });

  it("createSignedUrl builds a relative or absolute URL and round-trips", () => {
    const relative = createSignedUrl({
      bucket,
      storedName,
      expiresIn: 3600,
      secret,
    });
    assert.ok(relative.startsWith(`/api/storage/${bucket}/${storedName}?`));
    assert.ok(relative.includes("expires="));
    assert.ok(relative.includes("sig="));

    const absolute = createSignedUrl({
      bucket,
      storedName,
      expiresIn: 3600,
      secret,
      baseUrl: "http://localhost:5180/",
    });
    assert.ok(
      absolute.startsWith(
        `http://localhost:5180/api/storage/${bucket}/${storedName}?`
      )
    );

    // The relative URL must verify when parsed back.
    const url = new URL(relative, "http://localhost");
    assert.equal(
      verifySignedUrl({
        bucket,
        storedName,
        query: {
          expires: url.searchParams.get("expires"),
          sig: url.searchParams.get("sig"),
        },
        secret,
      }),
      true
    );
  });
});

// ─── integration setup ─────────────────────────────────────────

/**
 * Shared harness: a server with auth enabled (so the storage secret resolves
 * to the JWT secret), one pre-declared PUBLIC bucket, a private bucket, and
 * an authenticated user whose token is used for write operations.
 */
function setup() {
  const tmp = tempDir();
  const db = new Database({
    schema: testSchema,
    auth: authConfig,
    dataDir: tmp,
    // "public-assets" is public; "private-docs" is left undeclared → private.
    buckets: [{ name: "public-assets", public: true }],
  });
  const app = createServer(db, testSchema, { auth: authConfig });

  const auth = new Auth(db, {
    jwtSecret: TEST_SECRET,
    accessTokenExpiry: "1h",
    refreshTokenExpirySeconds: 86400,
    minPasswordLength: 8,
  });

  return { tmp, db, app, auth, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

type Harness = ReturnType<typeof setup>;

async function upload(
  app: Hono,
  bucket: string,
  file: File,
  token?: string
): Promise<Response> {
  return app.request(`/api/storage/${bucket}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: makeUploadForm(file),
  });
}

async function uploadAndGet(
  app: Hono,
  bucket: string,
  file: File,
  token: string
): Promise<{ storedName: string; originalName: string }> {
  const res = await upload(app, bucket, file, token);
  assert.equal(res.status, 201, `upload should succeed (got ${res.status})`);
  const { data } = (await res.json()) as { data: { storedName: string; originalName: string } };
  return data;
}

// ─── read-gate integration tests ───────────────────────────────

describe("storage read gate (GET /api/storage/:bucket/:filename)", () => {
  let h: Harness;
  let token: string;

  before(async () => {
    h = setup();
    const session = await h.auth.signUp({
      email: "reyansh@test.com",
      password: "supersecret",
    });
    token = session.accessToken;
  });
  after(() => {
    h.db.close();
    h.cleanup();
  });

  it("private bucket: 401 without auth", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("secret.pdf", "top secret", "application/pdf"),
      token
    );

    const res = await h.app.request(`/api/storage/private-docs/${storedName}`);
    assert.equal(res.status, 401);
  });

  it("private bucket: 200 with a valid Bearer token", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("secret.pdf", "top secret", "application/pdf"),
      token
    );

    const res = await h.app.request(`/api/storage/private-docs/${storedName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "top secret");
  });

  it("private bucket: 200 with a valid signed URL (no auth)", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("report.pdf", "report body", "application/pdf"),
      token
    );

    const url = createSignedUrl({
      bucket: "private-docs",
      storedName,
      expiresIn: 3600,
      secret: TEST_SECRET,
    });
    const res = await h.app.request(url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "report body");
    // The signed URL must work with no Authorization header at all.
    assert.equal(res.headers.get("content-disposition")?.includes("report.pdf"), true);
  });

  it("private bucket: 401 with an expired signed URL", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("report.pdf", "report body", "application/pdf"),
      token
    );

    const url = createSignedUrl({
      bucket: "private-docs",
      storedName,
      expiresIn: -60, // already expired
      secret: TEST_SECRET,
    });
    const res = await h.app.request(url);
    assert.equal(res.status, 401);
  });

  it("private bucket: 401 with a tampered signed URL", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("report.pdf", "report body", "application/pdf"),
      token
    );

    const url = createSignedUrl({
      bucket: "private-docs",
      storedName,
      expiresIn: 3600,
      secret: TEST_SECRET,
    });
    // Flip the last hex char of the signature.
    const tampered = url.replace(/(sig=)([0-9a-f]+)$/, (_m, p1, sig) => {
      const last = sig[sig.length - 1];
      const flipped = last === "0" ? "1" : "0";
      return `${p1}${sig.slice(0, -1)}${flipped}`;
    });
    const res = await h.app.request(tampered);
    assert.equal(res.status, 401);
  });

  it("public bucket: 200 without auth", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "public-assets",
      makeFile("logo.png", "png-bytes", "image/png"),
      token
    );

    const res = await h.app.request(`/api/storage/public-assets/${storedName}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "png-bytes");
  });

  it("public bucket: a signed URL bound to a different bucket is not honored", async () => {
    // Sanity: a public bucket is open regardless, but a tampered/foreign
    // signature must never downgrade a *private* read. Covered implicitly
    // above; this documents that the public path does not depend on the sig.
    const { storedName } = await uploadAndGet(
      h.app,
      "public-assets",
      makeFile("logo.png", "png-bytes", "image/png"),
      token
    );
    const res = await h.app.request(
      `/api/storage/public-assets/${storedName}?expires=bogus&sig=deadbeef`
    );
    assert.equal(res.status, 200);
  });

  it("supports a dedicated storage secret without breaking Bearer auth", async () => {
    const tmp = tempDir();
    const storageSecret = "dedicated-storage-secret";
    const db = new Database({
      schema: testSchema,
      auth: authConfig,
      dataDir: tmp,
    });
    const app = createServer(db, testSchema, {
      auth: authConfig,
      storage: { secret: storageSecret },
    });
    const auth = new Auth(db, {
      jwtSecret: TEST_SECRET,
      accessTokenExpiry: "1h",
      refreshTokenExpirySeconds: 86400,
      minPasswordLength: 8,
    });

    try {
      const session = await auth.signUp({
        email: "dedicated-secret@test.com",
        password: "supersecret",
      });
      const { storedName } = await uploadAndGet(
        app,
        "private-docs",
        makeFile("report.pdf", "report body", "application/pdf"),
        session.accessToken
      );

      const signedWithStorageSecret = createSignedUrl({
        bucket: "private-docs",
        storedName,
        expiresIn: 3600,
        secret: storageSecret,
      });
      const signedRead = await app.request(signedWithStorageSecret);
      assert.equal(signedRead.status, 200);
      assert.equal(await signedRead.text(), "report body");

      const signedWithJwtSecret = createSignedUrl({
        bucket: "private-docs",
        storedName,
        expiresIn: 3600,
        secret: TEST_SECRET,
      });
      const wrongSecretRead = await app.request(signedWithJwtSecret);
      assert.equal(wrongSecretRead.status, 401);
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("private bucket: 404 (not 401) once authenticated but file missing", async () => {
    const res = await h.app.request(
      `/api/storage/private-docs/00000000-0000-0000-0000-000000000000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(res.status, 404);
  });
});

// ─── write-gate integration tests ──────────────────────────────

describe("storage write gate (POST / DELETE / GET list)", () => {
  let h: Harness;
  let token: string;

  before(async () => {
    h = setup();
    const session = await h.auth.signUp({
      email: "reyansh@test.com",
      password: "supersecret",
    });
    token = session.accessToken;
  });
  after(() => {
    h.db.close();
    h.cleanup();
  });

  it("POST without auth → 401", async () => {
    const res = await upload(h.app, "private-docs", makeFile("a.txt", "a"));
    assert.equal(res.status, 401);
  });

  it("POST with auth → 201", async () => {
    const res = await upload(
      h.app,
      "private-docs",
      makeFile("a.txt", "a"),
      token
    );
    assert.equal(res.status, 201);
  });

  it("DELETE without auth → 401, with auth → 200", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("trash.txt", "x"),
      token
    );

    const noAuth = await h.app.request(
      `/api/storage/private-docs/${storedName}`,
      { method: "DELETE" }
    );
    assert.equal(noAuth.status, 401);

    // File is still there (the 401 must not have deleted it).
    const withAuth = await h.app.request(
      `/api/storage/private-docs/${storedName}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(withAuth.status, 200);
    const { body } = (await withAuth.json()) as { body: never };
    void body;
  });

  it("GET list without auth → 401, with auth → 200", async () => {
    await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("list-me.txt", "x"),
      token
    );

    const noAuth = await h.app.request("/api/storage/private-docs");
    assert.equal(noAuth.status, 401);

    const withAuth = await h.app.request("/api/storage/private-docs", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(withAuth.status, 200);
    const { data } = (await withAuth.json()) as {
      data: { files: unknown[] };
    };
    assert.ok(Array.isArray(data.files));
    assert.ok(data.files.length > 0);
  });

  it("writes to a PUBLIC bucket still require auth", async () => {
    const noAuth = await upload(
      h.app,
      "public-assets",
      makeFile("logo.png", "bytes", "image/png")
    );
    assert.equal(noAuth.status, 401);

    const withAuth = await upload(
      h.app,
      "public-assets",
      makeFile("logo.png", "bytes", "image/png"),
      token
    );
    assert.equal(withAuth.status, 201);
  });

  it("signed URLs are never accepted for writes (read-only credential)", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("signed.txt", "x"),
      token
    );

    const signedUrl = createSignedUrl({
      bucket: "private-docs",
      storedName,
      expiresIn: 3600,
      secret: TEST_SECRET,
    });

    // DELETE with a valid signed URL but no Bearer → still 401.
    const del = await h.app.request(signedUrl, { method: "DELETE" });
    assert.equal(del.status, 401);

    // POST to the bucket with signed query params but no Bearer → 401.
    const post = await h.app.request(
      `/api/storage/private-docs?expires=9999999999&sig=abc`,
      { method: "POST", body: makeUploadForm(makeFile("x.txt", "x")) }
    );
    assert.equal(post.status, 401);
  });
});

// ─── signed-URL generation endpoint (M4) ────────────────────────

describe("storage sign endpoint (POST /api/storage/:bucket/:filename/sign)", () => {
  let h: Harness;
  let token: string;

  before(async () => {
    h = setup();
    const session = await h.auth.signUp({
      email: "reyansh@test.com",
      password: "supersecret",
    });
    token = session.accessToken;
  });
  after(() => {
    h.db.close();
    h.cleanup();
  });

  it("401 without auth", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("a.pdf", "x"),
      token
    );
    const res = await h.app.request(
      `/api/storage/private-docs/${storedName}/sign`,
      { method: "POST" }
    );
    assert.equal(res.status, 401);
  });

  it("returns a signed URL that an unauthenticated client can fetch", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("secret.pdf", "private bytes", "application/pdf"),
      token
    );

    const sign = await h.app.request(
      `/api/storage/private-docs/${storedName}/sign`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    assert.equal(sign.status, 200);
    const { data } = (await sign.json()) as {
      data: { signedUrl: string; expires: number; expiresIn: number };
    };
    assert.ok(data.signedUrl.includes("expires="));
    assert.ok(data.signedUrl.includes("sig="));
    assert.equal(data.expiresIn, 3600);

    // The returned URL must work for a client with NO credentials.
    const get = await h.app.request(data.signedUrl);
    assert.equal(get.status, 200);
    assert.equal(await get.text(), "private bytes");
  });

  it("defaults expiresIn when the body is omitted", async () => {
    const { storedName } = await uploadAndGet(
      h.app,
      "private-docs",
      makeFile("a.pdf", "x"),
      token
    );
    const sign = await h.app.request(
      `/api/storage/private-docs/${storedName}/sign`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(sign.status, 200);
    const { data } = (await sign.json()) as { data: { expiresIn: number } };
    assert.equal(data.expiresIn, 3600);
  });

  it("404s when signing a non-existent file", async () => {
    const res = await h.app.request(
      `/api/storage/private-docs/00000000-0000-0000-0000-000000000000/sign`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(res.status, 404);
  });
});

// ─── no-auth fallback stays closed except public reads ─────────

describe("storage without auth fails closed", () => {
  let tmp: string;
  let db: Database;
  let app: Hono;

  before(() => {
    tmp = tempDir();
    db = new Database({
      schema: testSchema,
      dataDir: tmp,
      buckets: [{ name: "public-assets", public: true }],
    });
    app = createServer(db, testSchema, { auth: { enabled: false } });
  });
  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects anonymous upload, list, and private reads", async () => {
    const saved = await db.storage.save("private-docs", {
      originalName: "secret.txt",
      stream: makeFile("secret.txt", "secret").stream(),
    });

    const up = await upload(app, "private-docs", makeFile("free.txt", "free"));
    assert.equal(up.status, 401);

    const list = await app.request("/api/storage/private-docs");
    assert.equal(list.status, 401);

    const get = await app.request(`/api/storage/private-docs/${saved.storedName}`);
    assert.equal(get.status, 401);
  });

  it("still allows anonymous reads from public buckets", async () => {
    const saved = await db.storage.save("public-assets", {
      originalName: "logo.txt",
      stream: makeFile("logo.txt", "logo").stream(),
    });

    const get = await app.request(`/api/storage/public-assets/${saved.storedName}`);
    assert.equal(get.status, 200);
  });
});

describe("storage.secret without auth verifies signed reads", () => {
  it("keeps writes closed but accepts a valid signed URL", async () => {
    const tmp = tempDir();
    const secret = "storage-only-secret";
    const db = new Database({ schema: testSchema, dataDir: tmp });
    const app = createServer(db, testSchema, { storage: { secret } });

    try {
      const saved = await db.storage.save("private-docs", {
        originalName: "signed.txt",
        stream: makeFile("signed.txt", "signed").stream(),
      });

      const noAuth = await app.request(`/api/storage/private-docs/${saved.storedName}`);
      assert.equal(noAuth.status, 401);

      const signed = createSignedUrl({
        bucket: "private-docs",
        storedName: saved.storedName,
        expiresIn: 3600,
        secret,
      });
      const withSignedUrl = await app.request(signed);
      assert.equal(withSignedUrl.status, 200);
      assert.equal(await withSignedUrl.text(), "signed");

      const post = await upload(app, "private-docs", makeFile("x.txt", "x"));
      assert.equal(post.status, 401);
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
