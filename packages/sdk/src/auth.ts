/**
 * Public types for the SDK auth namespace. Kept dependency-free so the SDK
 * bundle doesn't pull in any server-side types from core.
 */

export interface AuthUser {
  id: number;
  email: string;
  created_at?: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds at which the access token expires. */
  expiresAt: number;
}

export interface AuthResponse {
  data: AuthSession | null;
  error: string | null;
}

export interface SignInResponse {
  data: { user: AuthUser } | null;
  error: string | null;
}

/** Internal — what the SDK client stores and passes to its query builder. */
export interface StoredSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
