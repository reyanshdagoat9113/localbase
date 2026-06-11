import type { Database } from "../db.js";
import { hashPassword, verifyPassword } from "./hash.js";
import {
  signAccessToken,
  generateRefreshToken,
} from "./tokens.js";
import {
  parseExpiryToSeconds,
  type ResolvedAuthConfig,
} from "./config.js";

/** Public user shape — what the API returns to clients. */
export interface AuthUser {
  id: number;
  email: string;
  created_at?: string;
}

/** The full session returned after signin / signup / refresh. */
export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  /** Unix-seconds when the access token expires. */
  expiresAt: number;
}

/** Stored session row, internal. */
interface SessionRow {
  id: number;
  user_id: number;
  token: string;
  expires_at: string;
}

/** Stored user row with the password hash attached, internal. */
interface UserRowWithHash extends AuthUser {
  password_hash: string;
}

/** Error type that the router maps to an HTTP response. */
export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Pragmatic email check. Doesn't aim to be RFC 5322-compliant — just
// catches the obvious "no @ sign" / "no domain" / "embedded whitespace"
// cases. The UNIQUE index on `email` is the real safety net.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new AuthError(400, "Email is required");
  }
  const normalized = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(normalized)) {
    throw new AuthError(400, "Invalid email format");
  }
  if (normalized.length > 320) {
    throw new AuthError(400, "Email is too long");
  }
  return normalized;
}

function validatePassword(
  raw: unknown,
  minLength: number
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AuthError(400, "Password is required");
  }
  if (raw.length < minLength) {
    throw new AuthError(
      400,
      `Password must be at least ${minLength} characters`
    );
  }
  return raw;
}

/**
 * Auth subsystem. Owns all reads/writes against the `_users` and
 * `_sessions` tables, and issues JWT access tokens plus rotating
 * refresh tokens. The router is a thin transport layer over this class.
 */
export class Auth {
  /** Public so the router can build `requireAuth` middleware with the same secret. */
  readonly config: ResolvedAuthConfig;

  constructor(
    private readonly db: Database,
    config: ResolvedAuthConfig
  ) {
    this.config = config;
  }

  // ─── Lookups ────────────────────────────────────────────────

  private findUserByEmail(email: string): UserRowWithHash | null {
    const rows = this.db.select("_users", {
      filters: [{ column: "email", operator: "eq", value: email }],
      limit: 1,
    });
    return (rows[0] as UserRowWithHash | undefined) ?? null;
  }

  private findUserById(id: number): UserRowWithHash | null {
    const row = this.db.selectById("_users", id) as
      | UserRowWithHash
      | undefined;
    return row ?? null;
  }

  publicUser(row: UserRowWithHash): AuthUser {
    return { id: row.id, email: row.email, created_at: row.created_at };
  }

  // ─── Session issuance ───────────────────────────────────────

  private async issueSession(user: AuthUser): Promise<AuthSession> {
    const accessToken = await signAccessToken(
      user,
      this.config.jwtSecret,
      this.config.accessTokenExpiry
    );
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.refreshTokenExpirySeconds * 1000
    ).toISOString();

    this.db.insert("_sessions", {
      user_id: user.id,
      token: refreshToken,
      expires_at: refreshExpiresAt,
    });

    const expiresAt =
      Math.floor(Date.now() / 1000) +
      parseExpiryToSeconds(this.config.accessTokenExpiry);

    return { user, accessToken, refreshToken, expiresAt };
  }

  // ─── Public API used by the router ─────────────────────────

  async signUp(input: Record<string, unknown>): Promise<AuthSession> {
    const email = validateEmail(input.email);
    const password = validatePassword(
      input.password,
      this.config.minPasswordLength
    );

    // Pre-check to surface a clean 409 instead of leaking the SQLite
    // constraint error. The UNIQUE index is still a backstop.
    if (this.findUserByEmail(email)) {
      throw new AuthError(409, "Email already registered");
    }

    const passwordHash = await hashPassword(password);
    const inserted = this.db.insert("_users", {
      email,
      password_hash: passwordHash,
    });
    const user = this.publicUser(inserted[0] as UserRowWithHash);
    return this.issueSession(user);
  }

  async signIn(input: Record<string, unknown>): Promise<AuthSession> {
    const email = validateEmail(input.email);
    if (typeof input.password !== "string" || input.password.length === 0) {
      throw new AuthError(400, "Password is required");
    }
    const password = input.password;

    const row = this.findUserByEmail(email);
    if (!row) {
      // Same message as a wrong password so attackers can't enumerate
      // which emails are registered.
      throw new AuthError(401, "Invalid email or password");
    }

    const valid = await verifyPassword(row.password_hash, password);
    if (!valid) {
      throw new AuthError(401, "Invalid email or password");
    }

    return this.issueSession(this.publicUser(row));
  }

  async signOut(refreshToken: string | undefined | null): Promise<void> {
    if (!refreshToken) {
      // Idempotent: signing out when you weren't signed in is fine.
      return;
    }
    this.db.delete("_sessions", [
      { column: "token", operator: "eq", value: refreshToken },
    ]);
  }

  getUser(userId: number): AuthUser | null {
    const row = this.findUserById(userId);
    return row ? this.publicUser(row) : null;
  }

  /**
   * Rotate a refresh token. The old token is invalidated as part of the
   * rotation — if a stolen token is presented after rotation, the
   * legitimate user's next refresh will fail and signal the compromise.
   */
  async refresh(refreshToken: string | undefined | null): Promise<AuthSession> {
    if (!refreshToken) {
      throw new AuthError(401, "Refresh token required");
    }

    const rows = this.db.select("_sessions", {
      filters: [{ column: "token", operator: "eq", value: refreshToken }],
      limit: 1,
    });
    const session = rows[0] as SessionRow | undefined;
    if (!session) {
      throw new AuthError(401, "Invalid refresh token");
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      // Lazy cleanup of expired sessions.
      this.db.delete("_sessions", [
        { column: "id", operator: "eq", value: session.id },
      ]);
      throw new AuthError(401, "Refresh token expired");
    }

    const userRow = this.findUserById(session.user_id);
    if (!userRow) {
      // Orphan session — the user was deleted. Clean up.
      this.db.delete("_sessions", [
        { column: "id", operator: "eq", value: session.id },
      ]);
      throw new AuthError(401, "User not found");
    }

    // Rotate: invalidate the old session, then issue a new one.
    this.db.delete("_sessions", [
      { column: "id", operator: "eq", value: session.id },
    ]);

    return this.issueSession(this.publicUser(userRow));
  }

  // ─── Admin API (used by the CLI) ───────────────────────────

  /** Create a user directly, without issuing tokens. Used by `localbase auth create-user`. */
  async createUser(input: Record<string, unknown>): Promise<AuthUser> {
    const email = validateEmail(input.email);
    const password = validatePassword(
      input.password,
      this.config.minPasswordLength
    );

    if (this.findUserByEmail(email)) {
      throw new AuthError(409, "Email already registered");
    }

    const passwordHash = await hashPassword(password);
    const inserted = this.db.insert("_users", {
      email,
      password_hash: passwordHash,
    });
    return this.publicUser(inserted[0] as UserRowWithHash);
  }

  /** List all users, oldest first. Password hashes are never returned. */
  listUsers(): AuthUser[] {
    const rows = this.db.select("_users", {
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    return (rows as UserRowWithHash[]).map((r) => this.publicUser(r));
  }

  /** Reset a user's password by email. Used by `localbase auth reset-password`. */
  async setPassword(
    emailRaw: unknown,
    newPasswordRaw: unknown
  ): Promise<void> {
    const email = validateEmail(emailRaw);
    const newPassword = validatePassword(
      newPasswordRaw,
      this.config.minPasswordLength
    );

    const user = this.findUserByEmail(email);
    if (!user) {
      throw new AuthError(404, `No user found with email "${email}"`);
    }

    const passwordHash = await hashPassword(newPassword);
    this.db.update(
      "_users",
      { password_hash: passwordHash },
      [{ column: "email", operator: "eq", value: email }]
    );
  }
}
