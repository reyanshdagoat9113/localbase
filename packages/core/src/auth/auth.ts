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
  /**
   * `"user"`, `"admin"`, or `"owner"`. Surfaced to clients (the admin SPA uses it to
   * decide what to render) and embedded in the access-token claim.
   */
  role: string;
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
 * Roles assignable through role-management operations. `owner` is deliberately
 * excluded: it is assigned only by the first-user bootstrap and cannot be
 * granted or removed through the admin API or CLI.
 * like `"adminn"` can't silently create an un-assignable role.
 */
const VALID_ROLES = new Set(["user", "admin"]);

function validateRole(raw: unknown): string {
  if (typeof raw !== "string" || !VALID_ROLES.has(raw)) {
    throw new AuthError(
      400,
      `Invalid role "${String(raw)}". Must be one of: ${[...VALID_ROLES].join(
        ", "
      )}.`
    );
  }
  return raw;
}

/**
 * Parse a route param into a positive integer user id. The admin user
 * endpoints are keyed by `:id` (the `_users.id` primary key), so callers hand
 * us a string; reject anything that isn't a positive integer with a 400 before
 * it reaches the DB layer.
 */
function parseUserId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AuthError(400, `Invalid user id: "${String(raw)}"`);
  }
  return n;
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
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
    };
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
    const passwordHash = await hashPassword(password);

    // Race-safe first-user bootstrap.
    //
    // "First user becomes owner" is fundamentally a check-then-act: count
    // `_users`, and if 0, grant owner. Two concurrent first signups (two
    // different emails, two near-simultaneous requests) could both observe
    // an empty table and both end up owner if the check isn't atomic with
    // the insert.
    //
    // We close that window by running the count-check and the insert
    // inside a single IMMEDIATE transaction. `BEGIN IMMEDIATE` acquires a
    // write lock *before* the read, so the second signer's transaction
    // blocks until the first commits — by which point the table is no
    // longer empty and `countUsers()` returns 1. better-sqlite3 exposes
    // this via `transaction(fn).immediate(...)`.
    //
    // Hashing is done *outside* the transaction so the (slow) argon2 call
    // doesn't hold the write lock.
    const insertFirstUser = this.db.raw().transaction((): AuthUser => {
      // Pre-check inside the lock for a clean 409 on duplicate email.
      // The UNIQUE index is still the ultimate backstop.
      if (this.findUserByEmail(email)) {
        throw new AuthError(409, "Email already registered");
      }
      const isFirstUser = this.countUsers() === 0;
      const role: string = isFirstUser ? "owner" : "user";
      const inserted = this.db.insert("_users", {
        email,
        password_hash: passwordHash,
        role,
      });
      return this.publicUser(inserted[0] as UserRowWithHash);
    });

    let user: AuthUser;
    try {
      user = insertFirstUser.immediate();
    } catch (err) {
      // The transaction surfaces the email-duplicate AuthError directly;
      // a UNIQUE-index collision from a concurrent insert also becomes a
      // clean 409.
      if (err instanceof AuthError) throw err;
      if (
        err instanceof Error &&
        "code" in err &&
        (err as Error & { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new AuthError(409, "Email already registered");
      }
      throw err;
    }

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
      // CLI-created users are regular users by default; promote via
      // `localbase admin:promote`.
      role: "user",
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

  /** List all users with administrative access, oldest first. */
  listAdmins(): AuthUser[] {
    const rows = this.db.select("_users", {
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    return (rows as UserRowWithHash[])
      .filter((r) => r.role === "admin" || r.role === "owner")
      .map((r) => this.publicUser(r));
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

  /**
   * Reset a user's password by id. The admin API identifies users by `:id`
   * (the `_users.id` primary key), but the password logic is email-keyed; this
   * resolves id → email and delegates to {@link setPassword} so the hashing,
   * min-length, and not-found semantics stay in one place. An owner may reset
   * their own password, but no other administrator may reset it.
   */
  async setPasswordById(
    idRaw: unknown,
    newPasswordRaw: unknown,
    actorId?: number
  ): Promise<void> {
    const id = parseUserId(idRaw);
    const user = this.findUserById(id);
    if (!user) {
      throw new AuthError(404, `No user found with id ${id}`);
    }
    if (user.role === "owner" && actorId !== user.id) {
      throw new AuthError(
        403,
        "The owner's password cannot be reset by an admin"
      );
    }
    await this.setPassword(user.email, newPasswordRaw);
  }

  // ─── Role management (admin:promote / admin:demote) ────────

  /** Total number of users. Used by the first-user bootstrap. */
  countUsers(): number {
    const row = this.db
      .raw()
      .prepare(`SELECT COUNT(*) AS n FROM "_users"`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Number of users with administrative access, including the owner. */
  countAdmins(): number {
    const row = this.db
      .raw()
      .prepare(
        `SELECT COUNT(*) AS n FROM "_users" WHERE "role" IN ('admin', 'owner')`
      )
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Promote or demote a user. Enforces the last-admin lockout: a demotion
   * that would leave zero admins is refused with 409. The `actorEmail`
   * (when provided) is included in the error so the UI/CLI can warn about
   * self-demotion specifically; the hard safety is the lockout itself.
   *
   * Returns the updated public user. No-op (returns the user unchanged)
   * when the role is already the requested value.
   */
  setRole(emailRaw: unknown, roleRaw: unknown, actorEmail?: string): AuthUser {
    const email = validateEmail(emailRaw);
    const role = validateRole(roleRaw);

    const updateRole = this.db.raw().transaction((): AuthUser => {
      const user = this.findUserByEmail(email);
      if (!user) {
        throw new AuthError(404, `No user found with email "${email}"`);
      }

      if (user.role === "owner") {
        throw new AuthError(409, "The owner role cannot be changed");
      }

      if (user.role === role) {
        // Idempotent — nothing to do.
        return this.publicUser(user);
      }

      if (role === "user") {
        // Demoting an admin. Block if it would leave the system with no
        // admins at all — that's an unrecoverable lockout (no one can ever
        // promote again without direct DB access). The actorEmail is
        // surfaced so callers can distinguish "you're demoting yourself" in
        // a confirmation prompt; enforcement of that confirmation is a UI
        // concern (M5), the backend just guarantees the invariant.
        if (this.countAdmins() <= 1) {
          const self =
            actorEmail !== undefined &&
            actorEmail.toLowerCase() === email.toLowerCase();
          throw new AuthError(
            409,
            self
              ? `Cannot demote "${email}": they are the last admin. Promote another user first.`
              : `Cannot demote "${email}": they are the last admin. Promote another user first.`
          );
        }
      }

      this.db.update(
        "_users",
        { role },
        [{ column: "email", operator: "eq", value: email }]
      );

      // Re-read to return the post-update row.
      const updated = this.findUserByEmail(email);
      return this.publicUser(updated!);
    });

    return updateRole.immediate();
  }

  /**
   * Promote or demote a user by id. Like {@link setPasswordById}, this resolves
   * id → email and delegates to {@link setRole}, so the last-admin lockout,
   * idempotency, and `actorEmail` (self-demotion messaging) semantics are
   * shared with the CLI path.
   */
  setRoleById(
    idRaw: unknown,
    roleRaw: unknown,
    actorEmail?: string
  ): AuthUser {
    const id = parseUserId(idRaw);
    const user = this.findUserById(id);
    if (!user) {
      throw new AuthError(404, `No user found with id ${id}`);
    }
    return this.setRole(user.email, roleRaw, actorEmail);
  }
}
