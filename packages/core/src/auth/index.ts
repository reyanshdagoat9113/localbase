// Auth subsystem: tables, hashing, tokens, middleware, router.

export { AUTH_SCHEMA } from "./schema.js";
export { hashPassword, verifyPassword } from "./hash.js";
export {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
} from "./tokens.js";
export type { AccessTokenClaims, RefreshTokenClaims } from "./tokens.js";
export {
  requireAuth,
  type AuthVariables,
  type AuthenticatedUser,
} from "./middleware.js";
export {
  resolveAuthConfig,
  generateJwtSecret,
  parseExpiryToSeconds,
  DEFAULT_ACCESS_TOKEN_EXPIRY,
  DEFAULT_REFRESH_TOKEN_EXPIRY_SECONDS,
  DEFAULT_MIN_PASSWORD_LENGTH,
  type ResolvedAuthConfig,
  type ResolvedAuthConfigResult,
} from "./config.js";
export { Auth, AuthError, type AuthUser, type AuthSession } from "./auth.js";
export { createAuthRouter } from "./router.js";
