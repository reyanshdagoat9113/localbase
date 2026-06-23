import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BucketConfig } from "@localbase/shared";
import type { Database } from "../db.js";

/**
 * Maximum valid bucket name length, chosen to keep filesystem paths well
 * below typical limits while matching common object-storage conventions.
 */
const MAX_BUCKET_NAME_LENGTH = 63;

/**
 * Strict allowlist for bucket names: lowercase letters, digits, and hyphens.
 * This avoids casing/encoding surprises across filesystems and keeps path
 * construction deterministic.
 */
const BUCKET_NAME_RE = /^[a-z0-9-]{1,63}$/;

/** Characters that must never appear in an original filename. */
const ORIGINAL_NAME_RE = /[\x00\\/]/;

/** Stored file metadata as it appears in the `_files` system table. */
export interface StoredFile {
  id: number;
  bucket: string;
  stored_name: string;
  original_name: string;
  size: number;
  mime: string | null;
  uploaded_at: string;
}

/** Result returned from {@link StorageEngine.save}. */
export interface SaveResult {
  id: number;
  path: string;
  storedName: string;
  originalName: string;
  size: number;
  mime: string | null;
}

/** Upload payload accepted by {@link StorageEngine.save}. */
export interface UploadPayload {
  /** User-facing filename (e.g. "report.pdf"). Never used as a filesystem path. */
  originalName: string;
  /** MIME type supplied by the client. Stored as-is, advisory only. */
  mime?: string;
  /** Known byte size, if available, for validation and metadata. */
  size?: number;
  /** Maximum allowed byte size for this upload. Enforced while streaming. */
  maxSize?: number;
  /** Raw byte stream to persist to disk. */
  stream: ReadableStream<Uint8Array>;
}

/** Options for constructing a {@link StorageEngine}. */
export interface StorageEngineOptions {
  /** The LocalBase database instance. */
  db: Database;
  /**
   * Root directory for file storage. Files are written under
   * `<root>/storage/<bucket>/<stored_name>`.
   */
  root: string;
  /** Optional pre-declared bucket configuration from `localbase.config.ts`. */
  buckets?: BucketConfig[];
}

/**
 * LocalBase file storage engine.
 *
 * Writes every file to a server-generated UUID name on disk while keeping the
 * original filename in the `_files` metadata table. This guarantees that the
 * user-supplied name can never be used for path traversal or to overwrite
 * another object.
 */
export class StorageEngine {
  private db: Database;
  private root: string;
  private buckets = new Map<string, { public: boolean }>();

  constructor(options: StorageEngineOptions) {
    this.db = options.db;
    this.root = path.resolve(options.root);

    for (const bucket of options.buckets ?? []) {
      assertValidBucketName(bucket.name);
      this.buckets.set(bucket.name, { public: bucket.public ?? false });
    }

    this.ensureIndexes();
  }

  /**
   * Returns the effective bucket configuration. If the bucket was not
   * pre-declared in config, it is materialized on first use as private.
   */
  getBucket(name: string): { public: boolean } {
    assertValidBucketName(name);
    let config = this.buckets.get(name);
    if (!config) {
      config = { public: false };
      this.buckets.set(name, config);
    }
    return config;
  }

  /**
   * Is the named bucket public? Unknown buckets are created lazily as
   * private, so this is always safe to call.
   */
  isPublic(name: string): boolean {
    return this.getBucket(name).public;
  }

  /**
   * Save a file to the given bucket.
   *
   * 1. Validate identifiers and reject path separators / null bytes.
   * 2. Generate a UUID `stored_name`.
   * 3. Stream the body to `<root>/storage/<bucket>/<stored_name>`.
   * 4. Insert a metadata row into `_files`.
   * 5. If the metadata insert fails, delete the orphaned on-disk file.
   */
  async save(bucket: string, payload: UploadPayload): Promise<SaveResult> {
    assertValidBucketName(bucket);
    assertValidOriginalName(payload.originalName);

    const storedName = randomUUID();
    const bucketDir = this.bucketDirectory(bucket);
    const filePath = path.join(bucketDir, storedName);

    fs.mkdirSync(bucketDir, { recursive: true });

    const size = await writeStream(payload.stream, filePath, payload.maxSize);

    let row: StoredFile;
    try {
      row = this.db.raw()
        .prepare(
          `INSERT INTO "_files" ("bucket", "stored_name", "original_name", "size", "mime")
           VALUES (?, ?, ?, ?, ?)
           RETURNING *`
        )
        .get(
          bucket,
          storedName,
          payload.originalName,
          size,
          payload.mime ?? null
        ) as StoredFile;
    } catch (err) {
      // Roll back the on-disk write if metadata could not be recorded.
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort cleanup; ignore failures.
      }
      throw err;
    }

    return {
      id: row.id,
      path: `${bucket}/${storedName}`,
      storedName: row.stored_name,
      originalName: row.original_name,
      size: row.size,
      mime: row.mime,
    };
  }

  /**
   * Retrieve a file from a bucket by its stored (UUID) name.
   * Returns the readable byte stream plus metadata, or `null` if no such
   * file exists.
   */
  get(bucket: string, storedName: string): { stream: ReadableStream<Uint8Array>; metadata: StoredFile } | null {
    assertValidBucketName(bucket);
    assertNoPathSeparators(storedName);

    const metadata = this.findByStoredName(bucket, storedName);
    if (!metadata) return null;

    const filePath = this.safeFilePath(bucket, storedName);
    if (!fs.existsSync(filePath)) return null;

    const nodeStream = fs.createReadStream(filePath);
    const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return { stream, metadata };
  }

  /**
   * Delete a file from a bucket by its stored (UUID) name.
   * Removes both the on-disk object and the metadata row. Returns `true` if
   * a row was deleted. Cleanup of the on-disk file is best-effort.
   */
  delete(bucket: string, storedName: string): boolean {
    assertValidBucketName(bucket);
    assertNoPathSeparators(storedName);

    const filePath = this.safeFilePath(bucket, storedName);

    const result = this.db.raw()
      .prepare(
        `DELETE FROM "_files" WHERE "bucket" = ? AND "stored_name" = ? RETURNING *`
      )
      .all(bucket, storedName) as StoredFile[];

    if (result.length === 0) return false;

    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup of the on-disk file; the metadata row is gone.
    }

    return true;
  }

  /**
   * List all files in a bucket, ordered by most recently uploaded first.
   */
  list(bucket: string): StoredFile[] {
    assertValidBucketName(bucket);

    return this.db.raw()
      .prepare(
        `SELECT * FROM "_files" WHERE "bucket" = ? ORDER BY "uploaded_at" DESC`
      )
      .all(bucket) as StoredFile[];
  }

  /**
   * Look up a file by its original (user-facing) name within a bucket.
   * Returns the first match. If multiple files share the same original name,
   * callers should prefer listing by stored name.
   */
  findByOriginalName(
    bucket: string,
    originalName: string
  ): StoredFile | null {
    assertValidBucketName(bucket);
    assertValidOriginalName(originalName);

    const row = this.db.raw()
      .prepare(
        `SELECT * FROM "_files" WHERE "bucket" = ? AND "original_name" = ? LIMIT 1`
      )
      .get(bucket, originalName) as StoredFile | undefined;

    return row ?? null;
  }

  /**
   * Return the absolute path to the bucket directory, resolving it against
   * the storage root.
   */
  bucketDirectory(bucket: string): string {
    assertValidBucketName(bucket);
    return path.resolve(this.root, "storage", bucket);
  }

  private findByStoredName(
    bucket: string,
    storedName: string
  ): StoredFile | null {
    const row = this.db.raw()
      .prepare(
        `SELECT * FROM "_files" WHERE "bucket" = ? AND "stored_name" = ? LIMIT 1`
      )
      .get(bucket, storedName) as StoredFile | undefined;

    return row ?? null;
  }

  /**
   * Resolve a filesystem path for a stored object and verify it stays inside
   * the bucket directory. This is the final safety check before any disk I/O.
   */
  private safeFilePath(bucket: string, storedName: string): string {
    const bucketDir = this.bucketDirectory(bucket);
    const filePath = path.resolve(bucketDir, storedName);

    const relative = path.relative(bucketDir, filePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative === ""
    ) {
      throw new StorageError(
        400,
        `Invalid file path: "${storedName}" resolves outside the bucket`
      );
    }

    return filePath;
  }

  /**
   * Ensure the `_files` table has the indexes expected by the storage
   * subsystem. Indexes are not tracked by the additive migration system,
   * so we create them idempotently here.
   *
   * If `_files` does not yet exist (e.g. the database was opened with
   * `autoMigrate: false`), we skip index creation. Operations that need the
   * table will fail later with a clear SQLite error.
   */
  ensureIndexes(): void {
    const exists = this.db.raw()
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_files'`
      )
      .get();
    if (!exists) return;

    this.db.raw().exec(`
      CREATE INDEX IF NOT EXISTS "_files_bucket_idx" ON "_files" ("bucket");
      CREATE INDEX IF NOT EXISTS "_files_bucket_original_name_idx" ON "_files" ("bucket", "original_name");
    `);
  }
}

/** Client-error type for storage operations. */
export class StorageError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function assertValidBucketName(name: string): void {
  if (
    typeof name !== "string" ||
    !BUCKET_NAME_RE.test(name) ||
    name.startsWith("-") ||
    name.endsWith("-")
  ) {
    throw new StorageError(
      400,
      `Invalid bucket name: "${name}". Bucket names must be 1-${MAX_BUCKET_NAME_LENGTH} lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen.`
    );
  }
}

function assertValidOriginalName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    ORIGINAL_NAME_RE.test(name)
  ) {
    throw new StorageError(
      400,
      `Invalid original filename: "${name}"`
    );
  }
}

function assertNoPathSeparators(name: string): void {
  if (typeof name !== "string" || name.length === 0 || /[\x00\\/]/.test(name)) {
    throw new StorageError(
      400,
      `Invalid file identifier: "${name}"`
    );
  }
}

/**
 * Pipe a web stream to disk with Node's backpressure/error handling, returning
 * the total number of bytes written.
 *
 * If `maxSize` is provided, the stream is aborted as soon as the running total
 * exceeds it and a {@link StorageError} with status 413 is thrown.
 */
async function writeStream(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  maxSize?: number
): Promise<number> {
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (maxSize !== undefined && total > maxSize) {
        callback(
          new StorageError(
            413,
            `File exceeds maximum allowed size of ${maxSize} bytes`
          )
        );
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      fs.createWriteStream(filePath)
    );
    if (maxSize !== undefined && total > maxSize) {
      throw new StorageError(
        413,
        `File exceeds maximum allowed size of ${maxSize} bytes`
      );
    }
    return total;
  } catch (err) {
    // Clean up partially-written file on error.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
    throw err;
  }
}
