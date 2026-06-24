import { Hono, type Context } from "hono";
import type { Database } from "../db.js";
import { authenticate } from "../auth/index.js";
import { StorageError, type StoredFile } from "./engine.js";
import { verifySignedUrl } from "./signed-urls.js";

/**
 * Default maximum upload size for a single file: 50 MiB.
 * This is a safety rail, not a quota system — per-bucket/user limits are
 * out of scope for the first cut.
 */
export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Options for {@link createStorageRouter}. */
export interface StorageRouterOptions {
  /**
   * Maximum file size in bytes accepted by `POST /api/storage/:bucket`.
   * @default DEFAULT_MAX_FILE_SIZE
   */
  maxFileSize?: number;
  /**
   * Secret used to verify Bearer access tokens for storage auth gates.
   * Usually the resolved auth JWT secret.
   */
  authSecret?: string;
  /**
   * Secret used to verify signed storage URLs. Defaults to `authSecret`.
   */
  signedUrlSecret?: string;
  /**
   * Back-compat alias used as both `authSecret` and `signedUrlSecret` when
   * the more specific secrets are omitted.
   */
  secret?: string;
}

/**
 * Hono router exposing the storage REST API at `/api/storage/*`.
 *
 * The host server mounts this at the root with
 * `app.route("/", createStorageRouter(db, { authSecret, signedUrlSecret }))`,
 * so paths are absolute.
 *
 * Security gates (M3):
 *   - Write gate — `POST` (upload), `DELETE`, and `GET /:bucket` (list)
 *     always require a valid Bearer token, regardless of bucket visibility.
 *   - Read gate — `GET /:bucket/:filename` is open for public buckets; for
 *     private buckets it requires either a valid signed URL
 *     (`?expires=&sig=`) or a Bearer token, else 401.
 *
 * Gates are active when an auth secret is provided (auth enabled). Without
 * one — a server running with auth disabled — storage stays open, preserving
 * the M2 surface. Signed URLs use the dedicated storage secret when provided,
 * otherwise the auth secret.
 */
export function createStorageRouter(
  db: Database,
  options: StorageRouterOptions = {}
): Hono {
  const router = new Hono();
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // ── M3 security gates ──────────────────────────────────────
  // When an auth secret is configured (auth enabled), the read and write
  // gates below are active. Without auth, storage stays open, matching the M2
  // surface. Signed URLs are bound to the dedicated storage secret if present,
  // otherwise to the auth secret.
  const authSecret = options.authSecret ?? options.secret;
  const signedUrlSecret = options.signedUrlSecret ?? options.secret ?? authSecret;
  const gated = Boolean(authSecret);

  /**
   * Write gate (upload / delete / list). Writes always require a valid
   * Bearer token, regardless of bucket visibility — a public bucket is open
   * for *reads*, not for writes. Signed URLs are read-only credentials and
   * are never accepted here.
   */
  async function passesWriteAuth(c: Context): Promise<boolean> {
    if (!gated) return true;
    const user = await authenticate(c, authSecret!);
    return user !== null;
  }

  /**
   * Read gate (file download). Branches:
   *   1. public bucket    → open;
   *   2. valid signed URL → open (lets unauthenticated clients read a private
   *      file, e.g. an `<img>` on a public page);
   *   3. valid Bearer token → open;
   *   4. otherwise → reject (handler returns 401).
   * `isPublic` validates the bucket name and throws StorageError(400) on an
   * invalid name, which the handler's try/catch maps to a 400.
   */
  async function passesReadGate(
    c: Context,
    bucket: string,
    storedName: string
  ): Promise<boolean> {
    if (!gated) return true;
    if (db.storage.isPublic(bucket)) return true;
    const url = new URL(c.req.url);
    if (
      verifySignedUrl({
        bucket,
        storedName,
        query: {
          expires: url.searchParams.get("expires"),
          sig: url.searchParams.get("sig"),
        },
        secret: signedUrlSecret!,
      })
    ) {
      return true;
    }
    const user = await authenticate(c, authSecret!);
    return user !== null;
  }

  // ── POST /api/storage/:bucket — upload file (auth required) ──
  router.post("/api/storage/:bucket", async (c) => {
    const bucket = c.req.param("bucket");

    try {
      if (!(await passesWriteAuth(c))) {
        return c.json({ error: "Authentication required" }, 401);
      }
      const body = await c.req.parseBody({ all: false });
      const file = body.file;

      if (!(file instanceof File)) {
        throw new StorageError(400, "Expected a single file under the 'file' field");
      }
      if (file.size > maxFileSize) {
        throw new StorageError(
          413,
          `File exceeds maximum allowed size of ${maxFileSize} bytes`
        );
      }

      const saved = await db.storage.save(bucket, {
        originalName: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        maxSize: maxFileSize,
        stream: file.stream(),
      });

      return c.json(
        {
          data: {
            id: saved.id,
            path: saved.path,
            storedName: saved.storedName,
            originalName: saved.originalName,
            size: saved.size,
            mime: saved.mime,
          },
        },
        201
      );
    } catch (err) {
      return storageErrorResponse(c, err);
    }
  });

  // ── GET /api/storage/:bucket/:filename — download file ───────
  router.get("/api/storage/:bucket/:filename", async (c) => {
    const bucket = c.req.param("bucket");
    const filename = c.req.param("filename");

    try {
      if (!(await passesReadGate(c, bucket, filename))) {
        return c.json({ error: "Authentication required" }, 401);
      }
      const found = db.storage.get(bucket, filename);
      if (!found) {
        return c.json({ error: "File not found" }, 404);
      }

      const { stream, metadata } = found;
      const contentType = metadata.mime || "application/octet-stream";
      const disposition = contentDisposition(metadata.original_name);

      c.header("Content-Type", contentType);
      c.header("Content-Disposition", disposition);
      c.header("Content-Length", String(metadata.size));

      return c.body(stream);
    } catch (err) {
      return storageErrorResponse(c, err);
    }
  });

  // ── DELETE /api/storage/:bucket/:filename — delete file (auth required) ──
  router.delete("/api/storage/:bucket/:filename", async (c) => {
    const bucket = c.req.param("bucket");
    const filename = c.req.param("filename");

    try {
      if (!(await passesWriteAuth(c))) {
        return c.json({ error: "Authentication required" }, 401);
      }
      const deleted = db.storage.delete(bucket, filename);
      if (!deleted) {
        return c.json({ error: "File not found" }, 404);
      }
      return c.json({ data: { deleted: true } });
    } catch (err) {
      return storageErrorResponse(c, err);
    }
  });

  // ── GET /api/storage/:bucket — list files (auth required) ────
  router.get("/api/storage/:bucket", async (c) => {
    const bucket = c.req.param("bucket");

    try {
      if (!(await passesWriteAuth(c))) {
        return c.json({ error: "Authentication required" }, 401);
      }
      const url = new URL(c.req.url);
      const { limit, offset } = parsePagination(url);

      const allFiles = db.storage.list(bucket);
      const total = allFiles.length;
      const files = paginate(allFiles, limit, offset);

      return c.json({
        data: {
          files: files.map(serializeFile),
          total,
        },
      });
    } catch (err) {
      return storageErrorResponse(c, err);
    }
  });

  return router;
}

function contentDisposition(originalName: string): string {
  // RFC 5987 / RFC 6266: use a quoted ASCII filename fallback and add the
  // UTF-8 filename* parameter when the original name contains non-ASCII bytes.
  const asciiOnly = /^[\x20-\x7E]+$/;
  const fallback = originalName
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/"/g, '\\"');
  if (asciiOnly.test(originalName)) {
    return `attachment; filename="${fallback}"`;
  }
  const utf8 = encodeURIComponent(originalName);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

function parsePagination(url: URL): { limit?: number; offset?: number } {
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");
  const result: { limit?: number; offset?: number } = {};

  if (limitStr !== null) {
    const n = Number(limitStr);
    if (!Number.isInteger(n) || n < 0) {
      throw new StorageError(
        400,
        `Invalid limit: "${limitStr}". Must be a non-negative integer.`
      );
    }
    result.limit = n;
  }

  if (offsetStr !== null) {
    const n = Number(offsetStr);
    if (!Number.isInteger(n) || n < 0) {
      throw new StorageError(
        400,
        `Invalid offset: "${offsetStr}". Must be a non-negative integer.`
      );
    }
    if (result.limit === undefined) {
      throw new StorageError(400, "offset requires limit");
    }
    result.offset = n;
  }

  return result;
}

function paginate<T>(items: T[], limit?: number, offset?: number): T[] {
  const start = offset ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  return items.slice(start, end);
}

function serializeFile(file: StoredFile) {
  return {
    id: file.id,
    bucket: file.bucket,
    storedName: file.stored_name,
    originalName: file.original_name,
    size: file.size,
    mime: file.mime,
    uploadedAt: file.uploaded_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function storageErrorResponse(c: any, err: unknown) {
  if (err instanceof StorageError) {
    return c.json({ error: err.message }, err.status as 400 | 404 | 413 | 500);
  }
  console.error("Storage API error:", err);
  return c.json({ error: "Internal server error" }, 500);
}
