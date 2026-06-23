import { Hono } from "hono";
import type { Database } from "../db.js";
import { StorageError, type StoredFile } from "./engine.js";

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
}

/**
 * Hono router exposing the storage REST API at `/api/storage/*`.
 *
 * The host server mounts this at the root with
 * `app.route("/", createStorageRouter(db))`, so paths are absolute.
 *
 * This router intentionally has no auth gate — that is layered on by the host
 * in M3. M2 only concerns itself with the multipart/file plumbing and the
 * basic `{ data } | { error }` response shape.
 */
export function createStorageRouter(
  db: Database,
  options: StorageRouterOptions = {}
): Hono {
  const router = new Hono();
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // ── POST /api/storage/:bucket — upload file ──────────────────
  router.post("/api/storage/:bucket", async (c) => {
    const bucket = c.req.param("bucket");

    try {
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

  // ── DELETE /api/storage/:bucket/:filename — delete file ──────
  router.delete("/api/storage/:bucket/:filename", async (c) => {
    const bucket = c.req.param("bucket");
    const filename = c.req.param("filename");

    try {
      const deleted = db.storage.delete(bucket, filename);
      if (!deleted) {
        return c.json({ error: "File not found" }, 404);
      }
      return c.json({ data: { deleted: true } });
    } catch (err) {
      return storageErrorResponse(c, err);
    }
  });

  // ── GET /api/storage/:bucket — list files ────────────────────
  router.get("/api/storage/:bucket", async (c) => {
    const bucket = c.req.param("bucket");

    try {
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
