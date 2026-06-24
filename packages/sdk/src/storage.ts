/**
 * Storage SDK — the `db.storage.from(bucket)` namespace.
 *
 * Buckets are addressed by name; files within a bucket are addressed by their
 * **original (user-facing) name** for ergonomics. The server stores files
 * under a server-generated UUID `stored_name`, so methods that target a single
 * file resolve `originalName → storedName` via a list lookup before hitting
 * the UUID-keyed REST endpoints.
 *
 *   upload(file)            → POST   multipart            (auth: write)
 *   list()                  → GET    /api/storage/:bucket (auth: write)
 *   download(originalName)  → list-resolve → GET :storedName (read gate)
 *   remove(originalName)    → list-resolve → DELETE :storedName (write gate)
 *   getPublicUrl(name)      → list-resolve → build /api/storage/:bucket/:storedName
 *   createSignedUrl(name)   → list-resolve → POST .../sign  (auth: write)
 *
 * Every method returns `{ data, error }` (download returns a Blob in `data`).
 * The signed-URL fetch from an *unauthenticated* client is demonstrated in
 * the integration tests: the authenticated app calls `createSignedUrl`, then
 * hands the resulting URL to a browser `<img>` / `fetch` with no token.
 *
 * ⚠️ Original-name collisions: two uploads with the same `original_name` in a
 * bucket produce two rows; resolution picks the first match. If that becomes
 * a problem, a `storedName`-keyed variant is a natural P1 follow-up (see the
 * storage plan, Open Question #1).
 */

/** A file's metadata, as returned by upload / list. Mirrors the REST shape. */
export interface StorageFile {
  id: number;
  bucket?: string;
  storedName: string;
  originalName: string;
  size: number;
  mime: string | null;
  uploadedAt?: string;
}

/** Result of `upload`. */
export interface UploadResult {
  data: StorageFile | null;
  error: string | null;
}

/** Generic SDK response envelope. */
export interface StorageResponse<T> {
  data: T | null;
  error: string | null;
}

/** Options for {@link StorageBucketClient.createSignedUrl}. */
export interface CreateSignedUrlOptions {
  /** Lifetime in seconds. Defaults to the server default (1 hour). */
  expiresIn?: number;
}

/** A file to upload — a browser `File`, a `Blob`, or a Blob-like object. */
export type Uploadable = Blob | File;

/**
 * Per-bucket storage client. Obtain one via `db.storage.from("avatars")`.
 */
export class StorageBucketClient {
  private readonly baseUrl: string;
  private readonly bucket: string;
  private readonly getToken: () => string | undefined;

  constructor(
    baseUrl: string,
    bucket: string,
    getToken: () => string | undefined
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.bucket = bucket;
    this.getToken = getToken;
  }

  /** Build the URL for a stored file (UUID-keyed). */
  private fileUrl(storedName: string): string {
    return `${this.baseUrl}/api/storage/${encodeURIComponent(this.bucket)}/${encodeURIComponent(storedName)}`;
  }

  /** `Authorization` header when a session is active, else undefined. */
  private authHeader(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * Resolve an `originalName` to its server `storedName` via a list lookup.
   * Returns `null` if no file in this bucket has that original name.
   */
  private async resolveStoredName(
    originalName: string
  ): Promise<string | null> {
    const { data, error } = await this.list();
    if (error || !data) return null;
    const match = data.find((f) => f.originalName === originalName);
    return match?.storedName ?? null;
  }

  /**
   * Upload a file to this bucket.
   *
   * @param file a browser `File`/`Blob`. When a plain `Blob` is passed, pass
   *             `filename` to set the stored original name (Blob has none).
   * @param filename optional original name when `file` is a `Blob`.
   */
  async upload(
    file: Uploadable,
    filename?: string
  ): Promise<UploadResult> {
    try {
      const form = new FormData();
      const originalName =
        filename ?? (file instanceof File ? file.name : "file");
      // Browsers set the multipart field name from the first arg; we always
      // send it under "file" to match the server's expectation.
      form.append("file", file, originalName);

      const res = await fetch(
        `${this.baseUrl}/api/storage/${encodeURIComponent(this.bucket)}`,
        { method: "POST", headers: this.authHeader(), body: form }
      );
      const json = (await res.json()) as {
        data?: StorageFile;
        error?: string;
      };
      if (!res.ok || json.error) {
        return {
          data: null,
          error: json.error ?? `Upload failed (${res.status})`,
        };
      }
      return { data: json.data ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  /**
   * List files in this bucket (most recent first).
   */
  async list(): Promise<StorageResponse<StorageFile[]>> {
    return this.getJson<StorageFile[]>(
      `${this.baseUrl}/api/storage/${encodeURIComponent(this.bucket)}`,
      (envelope) => envelope.files as StorageFile[] | undefined
    );
  }

  /**
   * Download a file as a Blob, addressed by its original name.
   * Resolves `originalName → storedName` via a list lookup first.
   */
  async download(
    originalName: string
  ): Promise<StorageResponse<Blob>> {
    try {
      const storedName = await this.resolveStoredName(originalName);
      if (!storedName) {
        return { data: null, error: `File not found: "${originalName}"` };
      }
      const res = await fetch(this.fileUrl(storedName), {
        headers: this.authHeader(),
      });
      if (!res.ok) {
        const text = await res.json().catch(() => ({}));
        return {
          data: null,
          error:
            (text as { error?: string }).error ??
            `Download failed (${res.status})`,
        };
      }
      return { data: await res.blob(), error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  /**
   * Delete a file by its original name.
   * Resolves `originalName → storedName` via a list lookup first.
   */
  async remove(
    originalName: string
  ): Promise<StorageResponse<{ deleted: boolean }>> {
    try {
      const storedName = await this.resolveStoredName(originalName);
      if (!storedName) {
        return { data: null, error: `File not found: "${originalName}"` };
      }
      return this.sendJson<{ deleted: boolean }>(
        this.fileUrl(storedName),
        "DELETE"
      );
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  /**
   * Build a URL for a file in a **public** bucket. Returns a root-relative
   * path by default; pass `absolute: true` for a fully-qualified URL.
   *
   * Resolves `originalName → storedName` via a list lookup (the server is
   * UUID-keyed), so this method is async. For public buckets the resulting
   * URL needs no token.
   */
  async getPublicUrl(
    originalName: string,
    options: { absolute?: boolean } = {}
  ): Promise<StorageResponse<string>> {
    const storedName = await this.resolveStoredName(originalName);
    if (!storedName) {
      return { data: null, error: `File not found: "${originalName}"` };
    }
    const relative = `/api/storage/${encodeURIComponent(this.bucket)}/${encodeURIComponent(storedName)}`;
    const url = options.absolute ? `${this.baseUrl}${relative}` : relative;
    return { data: url, error: null };
  }

  /**
   * Create a short-lived signed URL that lets an unauthenticated client read
   * this file (e.g. an `<img>` on a public page). Calls the server sign
   * endpoint — the signing secret never leaves the server.
   *
   * The returned URL is absolute when the server can determine its origin
   * (normal HTTP), otherwise root-relative.
   */
  async createSignedUrl(
    originalName: string,
    options: CreateSignedUrlOptions = {}
  ): Promise<StorageResponse<string>> {
    try {
      const storedName = await this.resolveStoredName(originalName);
      if (!storedName) {
        return { data: null, error: `File not found: "${originalName}"` };
      }
      const res = await fetch(
        `${this.fileUrl(storedName)}/sign`,
        {
          method: "POST",
          headers: {
            ...this.authHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            options.expiresIn !== undefined
              ? { expiresIn: options.expiresIn }
              : {}
          ),
        }
      );
      const json = (await res.json()) as {
        data?: { signedUrl: string };
        error?: string;
      };
      if (!res.ok || json.error) {
        return {
          data: null,
          error: json.error ?? `Sign failed (${res.status})`,
        };
      }
      return { data: json.data?.signedUrl ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  // ─── internal request helpers ───────────────────────────────

  /** GET a JSON endpoint whose payload is nested under a key, not `data`. */
  private async getJson<T>(
    url: string,
    extract: (data: Record<string, unknown>) => T | undefined
  ): Promise<StorageResponse<T>> {
    try {
      const res = await fetch(url, { headers: this.authHeader() });
      const json = (await res.json()) as {
        data?: Record<string, unknown>;
        error?: string;
      };
      if (!res.ok || json.error) {
        return {
          data: null,
          error: json.error ?? `Request failed (${res.status})`,
        };
      }
      const inner = json.data;
      if (!inner) return { data: null, error: null };
      return { data: extract(inner) ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }

  /** A state-changing request whose payload is the standard `{ data }`. */
  private async sendJson<T>(url: string, method: string): Promise<StorageResponse<T>> {
    try {
      const res = await fetch(url, {
        method,
        headers: this.authHeader(),
      });
      const json = (await res.json()) as { data?: T; error?: string };
      if (!res.ok || json.error) {
        return {
          data: null,
          error: json.error ?? `Request failed (${res.status})`,
        };
      }
      return { data: json.data ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: err instanceof Error ? err.message : "Network error",
      };
    }
  }
}

/**
 * The top-level `db.storage` namespace. `.from(bucket)` returns a per-bucket
 * client bound to the current session token.
 */
export interface StorageClient {
  from(bucket: string): StorageBucketClient;
}

/** Create the `db.storage` namespace, bound to the live session token. */
export function createStorageClient(
  baseUrl: string,
  getToken: () => string | undefined
): StorageClient {
  return {
    from(bucket: string): StorageBucketClient {
      return new StorageBucketClient(baseUrl, bucket, getToken);
    },
  };
}
