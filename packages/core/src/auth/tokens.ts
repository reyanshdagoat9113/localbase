import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const ACCESS_TOKEN_ALG = "HS256";
const REFRESH_TOKEN_BYTES = 32; // 256 bits of entropy

/** Public payload of an access token. */
export interface AccessTokenClaims {
  /** User id, stringified (JWT convention). */
  sub: string;
  /** User email at issuance time. */
  email: string;
  /**
   * User role at issuance time (`"user"` | `"admin"` | `"owner"`).
   *
   * ⚠️ This is a *snapshot* for convenience only. `requireAdmin` does NOT
   * trust it for authorization — it re-reads the current role from `_users`
   * on every request so a demotion takes effect immediately instead of
   * waiting for the token to expire. The claim exists so the SPA can render
   * admin-only UI without an extra round-trip, and so logs/telemetry carry
   * the role at issue time.
   */
  role: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiration (seconds since epoch). */
  exp: number;
  /** Unique id for this token — ensures successive tokens for the same
   *  user in the same second still have different signatures. */
  jti: string;
}

/** Public payload of a refresh token. */
export interface RefreshTokenClaims {
  /** User id, stringified. */
  sub: string;
  /** Unique identifier for this refresh token (the random string itself). */
  jti: string;
  /** Issued-at. */
  iat: number;
  /** Expiration. */
  exp: number;
}

/** Create the HMAC key once per process — `jose` does this internally too, but
 * keeping it explicit makes the encoding choice (UTF-8 bytes) obvious. */
function toKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Sign a short-lived access token for the given user.
 *
 * `expiresIn` is a string shorthand accepted by `jose` (e.g. "1h", "15m", "7d").
 *
 * `user.role` is embedded as a claim but is NOT authoritative for admin
 * authorization — see {@link AccessTokenClaims.role}.
 */
export async function signAccessToken(
  user: { id: number; email: string; role: string },
  secret: string,
  expiresIn: string
): Promise<string> {
  return new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALG })
    .setSubject(String(user.id))
    // jti is required so two tokens issued in the same second for the
    // same user are byte-for-byte distinct. Otherwise refresh would
    // produce a token identical to the one we're replacing.
    .setJti(crypto.randomBytes(16).toString("hex"))
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(toKey(secret));
}

/**
 * Verify an access token's signature and return its claims.
 * Throws `joseErrors.JWTExpired` or `joseErrors.JWTInvalid` on failure.
 */
export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, toKey(secret));
  return payload as unknown as AccessTokenClaims;
}

/**
 * Generate a cryptographically random refresh token. The returned string is
 * what gets stored in `_sessions.token` and returned to the client.
 */
export function generateRefreshToken(): string {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
}
