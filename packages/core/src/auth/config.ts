import crypto from "node:crypto";
import type { AuthConfig } from "@localbase/shared";

export const DEFAULT_ACCESS_TOKEN_EXPIRY = "1h";
/** 30 days, in seconds. */
export const DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_MIN_PASSWORD_LENGTH = 8;

/**
 * The user-facing `AuthConfig` from `localbase.config.ts` after defaults
 * have been applied and a (possibly generated) secret has been resolved.
 */
export interface ResolvedAuthConfig {
  jwtSecret: string;
  accessTokenExpiry: string;
  refreshTokenExpirySeconds: number;
  minPasswordLength: number;
}

export interface ResolvedAuthConfigResult {
  config: ResolvedAuthConfig;
  /** True when a secret was generated on the fly because none was provided. */
  secretWasGenerated: boolean;
}

/**
 * Parse a `jose`-style expiry shorthand ("1h", "15m", "7d", "30s") into
 * a number of seconds. Throws on malformed input.
 */
export function parseExpiryToSeconds(expiry: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(expiry.trim());
  if (!match) {
    throw new Error(
      `Invalid expiry "${expiry}". Expected shorthand like "1h", "15m", "7d", or "30s".`
    );
  }
  const n = Number(match[1]);
  switch (match[2]) {
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 60 * 60;
    case "d":
      return n * 24 * 60 * 60;
    default:
      // Unreachable, the regex above pins the alternatives.
      throw new Error(`Invalid expiry unit: ${match[2]}`);
  }
}

/**
 * Generate a cryptographically random 256-bit secret, hex-encoded.
 * Used as a fallback when the user hasn't provided a `jwtSecret`.
 */
export function generateJwtSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Merge the user's `AuthConfig` with defaults, and generate a random
 * secret if one wasn't provided. Callers should check `secretWasGenerated`
 * and warn the user — random secrets are invalidated on every restart
 * and will sign everyone out.
 */
export function resolveAuthConfig(config: AuthConfig): ResolvedAuthConfigResult {
  const accessTokenExpiry =
    config.accessTokenExpiry ?? DEFAULT_ACCESS_TOKEN_EXPIRY;
  // Validate the access-token expiry up-front so we fail fast at startup,
  // not on the first request that needs a token.
  parseExpiryToSeconds(accessTokenExpiry);

  const base = {
    accessTokenExpiry,
    refreshTokenExpirySeconds:
      config.refreshTokenExpiry ?? DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS,
    minPasswordLength: config.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH,
  };

  if (config.jwtSecret) {
    return { config: { jwtSecret: config.jwtSecret, ...base }, secretWasGenerated: false };
  }

  return {
    config: { jwtSecret: generateJwtSecret(), ...base },
    secretWasGenerated: true,
  };
}
