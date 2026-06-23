import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "../db.js";
import { StorageError } from "./engine.js";
import type { DatabaseSchema } from "@localbase/shared";

const testSchema: DatabaseSchema = {
  users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "text", nullable: false },
  },
};

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(result);
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localbase-storage-"));
}

describe("StorageEngine", () => {
  let db: Database;
  let tmp: string;

  before(() => {
    tmp = tempDir();
    db = new Database({
      schema: testSchema,
      dataDir: tmp,
    });
  });

  after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("should round-trip a file", async () => {
    const saved = await db.storage.save("documents", {
      originalName: "report.pdf",
      mime: "application/pdf",
      stream: makeStream("hello world"),
    });

    assert.equal(saved.originalName, "report.pdf");
    assert.equal(saved.size, 11);
    assert.equal(saved.mime, "application/pdf");
    assert.ok(saved.storedName.length > 0);
    assert.ok(saved.path.startsWith("documents/"));

    const found = db.storage.get("documents", saved.storedName);
    assert.ok(found);
    assert.equal(found.metadata.original_name, "report.pdf");
    assert.equal(found.metadata.size, 11);

    const body = await readStream(found.stream);
    assert.equal(body, "hello world");
  });

  it("should list files in a bucket", async () => {
    await db.storage.save("avatars", {
      originalName: "a.png",
      mime: "image/png",
      stream: makeStream("a"),
    });
    await db.storage.save("avatars", {
      originalName: "b.png",
      mime: "image/png",
      stream: makeStream("b"),
    });

    const files = db.storage.list("avatars");
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.bucket === "avatars"));
    assert.ok(
      files.some((f) => f.original_name === "a.png"),
      "should include a.png"
    );
    assert.ok(
      files.some((f) => f.original_name === "b.png"),
      "should include b.png"
    );
  });

  it("should delete a file", async () => {
    const saved = await db.storage.save("documents", {
      originalName: "temp.txt",
      stream: makeStream("delete me"),
    });

    const before = db.storage.get("documents", saved.storedName);
    assert.ok(before);

    const deleted = db.storage.delete("documents", saved.storedName);
    assert.equal(deleted, true);

    const after = db.storage.get("documents", saved.storedName);
    assert.equal(after, null);

    const diskPath = path.join(tmp, "storage", "documents", saved.storedName);
    assert.equal(fs.existsSync(diskPath), false);
  });

  it("should return false when deleting a non-existent file", () => {
    const deleted = db.storage.delete("documents", "00000000-0000-0000-0000-000000000000");
    assert.equal(deleted, false);
  });

  it("should find a file by original name", async () => {
    await db.storage.save("documents", {
      originalName: "find-me.txt",
      stream: makeStream("content"),
    });

    const found = db.storage.findByOriginalName("documents", "find-me.txt");
    assert.ok(found);
    assert.equal(found.original_name, "find-me.txt");
  });

  it("should store files under UUID names on disk", async () => {
    const saved = await db.storage.save("uuid-demo", {
      originalName: "tricky name.txt",
      stream: makeStream("safe"),
    });

    // The original name is preserved as metadata, but the disk name is a UUID.
    assert.equal(saved.originalName, "tricky name.txt");
    const diskPath = path.join(tmp, "storage", "uuid-demo", saved.storedName);
    assert.ok(fs.existsSync(diskPath));
    assert.equal(
      fs.readdirSync(path.join(tmp, "storage", "uuid-demo")).length,
      1
    );
  });

  it("should reject path traversal in bucket names", () => {
    assert.throws(
      () => db.storage.list("../escape"),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });

  it("should reject absolute bucket names", () => {
    assert.throws(
      () => db.storage.list("/etc/passwd"),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });

  it("should reject bucket names with null bytes", () => {
    assert.throws(
      () => db.storage.list("bucket\x00name"),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });

  it("should reject overly long bucket names", () => {
    assert.throws(
      () => db.storage.list("a".repeat(64)),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });

  it("should reject bucket names starting or ending with hyphen", () => {
    assert.throws(
      () => db.storage.list("-bucket"),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
    assert.throws(
      () => db.storage.list("bucket-"),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });

  it("should reject path separators in original names", async () => {
    await assert.rejects(
      db.storage.save("documents", {
        originalName: "../../passwd",
        stream: makeStream("bad"),
      }),
      (err) => err instanceof StorageError && /Invalid original filename/.test((err as StorageError).message)
    );
  });

  it("should reject null bytes in original names", async () => {
    await assert.rejects(
      db.storage.save("documents", {
        originalName: "file\x00.txt",
        stream: makeStream("bad"),
      }),
      (err) => err instanceof StorageError && /Invalid original filename/.test((err as StorageError).message)
    );
  });

  it("should keep bucket directories isolated", async () => {
    const saved = await db.storage.save("bucket-a", {
      originalName: "shared.txt",
      stream: makeStream("a"),
    });

    const cross = db.storage.get("bucket-b", saved.storedName);
    assert.equal(cross, null);
  });

  it("should report public buckets from config", () => {
    const publicDb = new Database({
      schema: testSchema,
      dataDir: tmp,
      buckets: [{ name: "public-bucket", public: true }],
      autoMigrate: false,
    });
    assert.equal(publicDb.storage.isPublic("public-bucket"), true);
    assert.equal(publicDb.storage.isPublic("private-bucket"), false);
    publicDb.close();
  });

  it("should reject invalid bucket names in config", () => {
    assert.throws(
      () =>
        new Database({
          schema: testSchema,
          dataDir: tmp,
          buckets: [{ name: "BadName" }],
          autoMigrate: false,
        }),
      (err) => err instanceof StorageError && /Invalid bucket name/.test(err.message)
    );
  });
});
