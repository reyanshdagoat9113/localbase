import crypto from "node:crypto";

/**
 * Signed URLs for the storage subsystem.
 *
 * A signed URL is an alternative, single-resource credential: it lets an
 * unauthenticated client (e.g. an `<img>` tag on a public page) read one
 * specific private file until it expires, without ever holding a user
 * session. It is the read-side counterpart to the Bearer-token auth gate.
 *
 * Signature scheme (Decision #4 of the storage plan):
 *
 *   sig = HMAC-SHA256(secret, bucket + "/" + stored_name + "|" + expires)
 *
 * where `expires` is a unix-seconds integer. The signed resource is the
 * (bucket, stored_name) pair — the server-generated UUID name on disk, never
 * the user-supplied original name. A signed URL is presented as query params:
 *
 *   GET /api/storage/<bucket>/<stored_name>?expires=<unix>&sig=<hex>
 *
 * Revocation = secret rotation: changing the storage secret invalidates every
 * outstanding signature immediately. Expiry is the other control — keep
 * expirations short by default (see the storage plan's risk notes).
 *
 * The verify path is constant-time (crypto.timingSafeEqual over equal-length
 * buffers) and rejects expired, malformed, or tampered signatures without
 * leaking timing information about which check failed.
 */

/** Signature output: the two query params that accompany a signed URL. */
export interface SignedUrlQuery {
  /** Expiry as a unix-seconds integer string (the exact bytes that were signed). */
  expires: string;
  /** Hex-encoded HMAC-SHA256 signature. */
  sig: string;
}

/** Parameters for {@link signStorageUrl}. */
export interface SignStorageUrlParams {
  bucket: string;
  /** The on-disk UUID name (never the original filename). */
  storedName: string;
  /** Expiry as unix seconds. Truncated to an integer before signing. */
  expires: number;
  secret: string;
}

/** Parameters for {@link verifySignedUrl}. */
export interface VerifySignedUrlParams {
  bucket: string;
  storedName: string;
  /** Query params from the request (typically `c.req.query()`). */
  query: {
    expires?: string | null;
    sig?: string | null;
  };
  secret: string;
  /** Override "now" (unix seconds) for deterministic tests. */
  now?: number;
}

/** Parameters for {@link createSignedUrl}. */
export interface CreateSignedUrlParams {
  bucket: string;
  storedName: string;
  /** Lifetime in seconds from issuance. */
  expiresIn: number;
  secret: string;
  /**
   * Origin to prefix (e.g. "http://localhost:5180"). When omitted, a
   * root-relative path is produced — handy for tests and SDKs that build
   * the absolute URL themselves.
   */
  baseUrl?: string;
  /** Override "now" (unix seconds) for deterministic tests. */
  now?: number;
}

/**
 * Compute the canonical signature for a (bucket, storedName, expires) triple.
 * Centralising the message format in one place guarantees sign and verify
 * agree byte-for-byte.
 */
function computeSignature(
  bucket: string,
  storedName: string,
  expiresStr: string,
  secret: string
): string {
  const message = `${bucket}/${storedName}|${expiresStr}`;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Sign a single storage resource, returning the `expires` + `sig` query params.
 *
 * The caller is responsible for the expiry value. Use {@link createSignedUrl}
 * for the more ergonomic "expires in N seconds" form that also builds the URL.
 */
export function signStorageUrl(params: SignStorageUrlParams): SignedUrlQuery {
  const expiresStr = String(Math.trunc(params.expires));
  const sig = computeSignature(
    params.bucket,
    params.storedName,
    expiresStr,
    params.secret
  );
  return { expires: expiresStr, sig };
}

/**
 * Verify a signed URL's query params against a secret.
 *
 * Returns `true` only when ALL of:
 *   - both `expires` and `sig` are present,
 *   - `expires` is a plain integer string (no decimals / sign / letters),
 *   - the URL has not expired (`now < expires`),
 *   - the signature matches, compared in constant time.
 *
 * Any other input returns `false`. The function never throws, so callers can
 * treat it as a simple boolean gate.
 */
export function verifySignedUrl(params: VerifySignedUrlParams): boolean {
  const { bucket, storedName, query, secret } = params;

  const expiresStr =
    typeof query.expires === "string" ? query.expires : null;
  const sig = typeof query.sig === "string" ? query.sig : null;
  if (!expiresStr || !sig) return false;

  // Reject anything that isn't a clean non-negative integer string. This
  // pins the signed bytes to the exact string in the URL (no reformatting
  // surprises) and dodges Number() quirks like "1e2".
  if (!/^\d+$/.test(expiresStr)) return false;

  const expires = Number(expiresStr);
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (now >= expires) return false; // expired or exactly at expiry

  const expected = computeSignature(bucket, storedName, expiresStr, secret);
  return timingSafeEqualHex(sig, expected);
}

/**
 * Build a complete signed URL string, computing the expiry as
 * `now + expiresIn`. The most common entry point for issuing a signed URL
 * (the SDK's `createSignedUrl` maps directly onto this).
 */
export function createSignedUrl(params: CreateSignedUrlParams): string {
  const { bucket, storedName, expiresIn, secret, baseUrl, now } = params;
  const issuedAt = now ?? Math.floor(Date.now() / 1000);
  const expires = issuedAt + expiresIn;

  const { expires: expiresStr, sig } = signStorageUrl({
    bucket,
    storedName,
    expires,
    secret,
  });

  const path = `/api/storage/${encodeURIComponent(bucket)}/${encodeURIComponent(storedName)}`;
  const qs = `?expires=${expiresStr}&sig=${sig}`;
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}${path}${qs}` : `${path}${qs}`;
}

/**
 * Constant-time comparison of two hex strings.
 *
 * `expected` is always a 64-char hex digest (32 bytes). If `actual` is not
 * valid hex or is a different length, the buffers differ in length and we
 * return `false` *before* calling `timingSafeEqual`, which would otherwise
 * throw on unequal lengths.
 */
function timingSafeEqualHex(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}
