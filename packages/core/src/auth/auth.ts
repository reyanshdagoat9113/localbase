import type { Database } from "../db.js";
import { DatabaseError } from "../db/index.js";
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

interface AdminRequestRow {
  id: number;
  email: string;
  password_hash: string;
  user_id?: number | null;
  created_at: string;
}

export interface AdminRequest {
  id: number;
  email: string;
  kind: "create" | "promote";
  created_at: string;
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

  private async findUserByEmail(email: string): Promise<UserRowWithHash | null> {
    const rows = await this.db.select("_users", {
      filters: [{ column: "email", operator: "eq", value: email }],
      limit: 1,
    });
    return (rows[0] as UserRowWithHash | undefined) ?? null;
  }

  private async findUserById(id: number): Promise<UserRowWithHash | null> {
    const row = (await this.db.selectById("_users", id)) as
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

  private publicAdminRequest(row: AdminRequestRow): AdminRequest {
    return {
      id: row.id,
      email: row.email,
      kind: row.user_id == null ? "create" : "promote",
      created_at: row.created_at,
    };
  }

  private assertOwner(actorRole: string | undefined): void {
    if (actorRole !== "owner") {
      throw new AuthError(403, "Owner access required");
    }
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

    await this.db.insert("_sessions", {
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

  async signUp(
    input: Record<string, unknown>,
    requireOwnerBootstrap = false
  ): Promise<AuthSession> {
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
    let user: AuthUser;
    try {
      user = await this.db.transaction(async (): Promise<AuthUser> => {
        if (await this.findUserByEmail(email)) {
          throw new AuthError(409, "Email already registered");
        }
        const isFirstUser = (await this.countUsers()) === 0;
        if (requireOwnerBootstrap && !isFirstUser) {
          throw new AuthError(409, "The owner account has already been created");
        }
        const role: string = isFirstUser ? "owner" : "user";
        const inserted = await this.db.insert("_users", {
          email,
          password_hash: passwordHash,
          role,
        });
        return this.publicUser(inserted[0] as UserRowWithHash);
      });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof DatabaseError && err.code === "unique") {
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

    const row = await this.findUserByEmail(email);
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

  async hasOwner(): Promise<boolean> {
    const rows = await this.db.select("_users", {
      filters: [{ column: "role", operator: "eq", value: "owner" }],
      limit: 1,
    });
    return rows.length > 0;
  }

  async requestAdmin(input: Record<string, unknown>): Promise<AdminRequest> {
    const email = validateEmail(input.email);
    const password = validatePassword(
      input.password,
      this.config.minPasswordLength
    );
    const existingUser = await this.findUserByEmail(email);
    if (existingUser && existingUser.role !== "user") {
      throw new AuthError(409, "This account already has admin access");
    }
    if (
      existingUser &&
      !(await verifyPassword(existingUser.password_hash, password))
    ) {
      throw new AuthError(401, "Invalid email or password");
    }
    const passwordHash = existingUser
      ? existingUser.password_hash
      : await hashPassword(password);

    return this.db.transaction(async (): Promise<AdminRequest> => {
      if (!(await this.hasOwner())) {
        throw new AuthError(409, "Create the owner before requesting admin access");
      }
      const currentUser = await this.findUserByEmail(email);
      if (existingUser) {
        if (
          !currentUser ||
          currentUser.id !== existingUser.id ||
          currentUser.role !== "user" ||
          currentUser.password_hash !== passwordHash
        ) {
          throw new AuthError(409, "Account changed while creating the request; try again");
        }
      } else if (currentUser) {
        throw new AuthError(409, "Email was registered while creating the request; try again");
      }
      const pendingRows = await this.db.select("_admin_requests", {
        filters: [{ column: "email", operator: "eq", value: email }],
        limit: 1,
      });
      const pending = pendingRows[0] as AdminRequestRow | undefined;
      if (pending) {
        throw new AuthError(409, "An admin request is already pending for this email");
      }
      const insertedRows = await this.db.insert("_admin_requests", {
        email,
        password_hash: passwordHash,
        user_id: existingUser?.id ?? null,
      });
      return this.publicAdminRequest(insertedRows[0] as AdminRequestRow);
    });
  }

  async listAdminRequests(
    actorRole: string | undefined,
    limit = 100,
    offset = 0
  ): Promise<{ requests: AdminRequest[]; total: number }> {
    this.assertOwner(actorRole);
    const rows = (await this.db.select("_admin_requests", {
      orderBy: [{ column: "created_at", direction: "asc" }],
      limit,
      offset,
    })) as AdminRequestRow[];
    return {
      requests: rows.map((row) => this.publicAdminRequest(row)),
      total: await this.db.count("_admin_requests"),
    };
  }

  async approveAdminRequest(
    idRaw: unknown,
    actorRole: string | undefined
  ): Promise<AuthUser> {
    this.assertOwner(actorRole);
    const id = parseUserId(idRaw);
    return this.db.transaction(async (): Promise<AuthUser> => {
      const request = (await this.db.selectById("_admin_requests", id)) as
        | AdminRequestRow
        | undefined;
      if (!request) {
        throw new AuthError(404, `No admin request found with id ${id}`);
      }
      let approved: UserRowWithHash;
      if (request.user_id != null) {
        const existing = await this.findUserById(request.user_id);
        if (!existing || existing.email !== request.email) {
          throw new AuthError(409, "The account for this request no longer exists");
        }
        if (existing.role !== "user") {
          throw new AuthError(409, "This account already has admin access");
        }
        await this.db.update(
          "_users",
          { role: "admin" },
          [{ column: "id", operator: "eq", value: existing.id }]
        );
        approved = (await this.findUserById(existing.id))!;
      } else {
        if (await this.findUserByEmail(request.email)) {
          throw new AuthError(409, "Email already registered");
        }
        const inserted = await this.db.insert("_users", {
          email: request.email,
          password_hash: request.password_hash,
          role: "admin",
        });
        approved = inserted[0] as UserRowWithHash;
      }
      await this.db.delete("_admin_requests", [
        { column: "id", operator: "eq", value: id },
      ]);
      return this.publicUser(approved);
    });
  }

  async rejectAdminRequest(
    idRaw: unknown,
    actorRole: string | undefined
  ): Promise<void> {
    this.assertOwner(actorRole);
    const id = parseUserId(idRaw);
    const deleted = await this.db.delete("_admin_requests", [
      { column: "id", operator: "eq", value: id },
    ]);
    if (deleted === 0) {
      throw new AuthError(404, `No admin request found with id ${id}`);
    }
  }

  async signOut(refreshToken: string | undefined | null): Promise<void> {
    if (!refreshToken) {
      // Idempotent: signing out when you weren't signed in is fine.
      return;
    }
    await this.db.delete("_sessions", [
      { column: "token", operator: "eq", value: refreshToken },
    ]);
  }

  async getUser(userId: number): Promise<AuthUser | null> {
    const row = await this.findUserById(userId);
    return row ? this.publicUser(row) : null;
  }

  /**
   * Atomically rotate a refresh token. Consumes the old token in a single
   * `DELETE ... WHERE token = ? RETURNING *` so two concurrent refresh
   * requests carrying the same token can never both mint sessions.
   */
  async refresh(refreshToken: string | undefined | null): Promise<AuthSession> {
    if (!refreshToken) {
      throw new AuthError(401, "Refresh token required");
    }

    const deleted = (await this.db.deleteReturning("_sessions", [
      { column: "token", operator: "eq", value: refreshToken },
    ])) as SessionRow[];
    const session = deleted[0];
    if (!session) {
      throw new AuthError(401, "Invalid refresh token");
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      throw new AuthError(401, "Refresh token expired");
    }

    const userRow = await this.findUserById(session.user_id);
    if (!userRow) {
      throw new AuthError(401, "User not found");
    }

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

    if (await this.findUserByEmail(email)) {
      throw new AuthError(409, "Email already registered");
    }

    const passwordHash = await hashPassword(password);
    try {
      const inserted = await this.db.insert("_users", {
        email,
        password_hash: passwordHash,
        // CLI-created users are regular users by default; promote via
        // `localbase admin:promote`.
        role: "user",
      });
      return this.publicUser(inserted[0] as UserRowWithHash);
    } catch (err) {
      if (err instanceof DatabaseError && err.code === "unique") {
        throw new AuthError(409, "Email already registered");
      }
      throw err;
    }
  }

  /** List all users, oldest first. Password hashes are never returned. */
  async listUsers(): Promise<AuthUser[]> {
    const rows = await this.db.select("_users", {
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    return (rows as UserRowWithHash[]).map((r) => this.publicUser(r));
  }

  /** List all users with administrative access, oldest first. */
  async listAdmins(): Promise<AuthUser[]> {
    const rows = await this.db.select("_users", {
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

    const user = await this.findUserByEmail(email);
    if (!user) {
      throw new AuthError(404, `No user found with email "${email}"`);
    }

    const passwordHash = await hashPassword(newPassword);
    await this.db.update(
      "_users",
      { password_hash: passwordHash },
      [{ column: "email", operator: "eq", value: email }]
    );
    // Revoke all active refresh sessions so existing tokens cannot mint new
    // access tokens after a password reset.
    await this.db.delete("_sessions", [
      { column: "user_id", operator: "eq", value: user.id },
    ]);
  }

  async setPasswordById(
    idRaw: unknown,
    newPasswordRaw: unknown,
    actorId?: number
  ): Promise<void> {
    const id = parseUserId(idRaw);
    const user = await this.findUserById(id);
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
  async countUsers(): Promise<number> {
    return this.db.count("_users");
  }

  /** Number of users with administrative access, including the owner. */
  async countAdmins(): Promise<number> {
    return this.db.count("_users", [
      { column: "role", operator: "in", value: ["admin", "owner"] },
    ]);
  }

  async setRole(
    emailRaw: unknown,
    roleRaw: unknown,
    actorEmail?: string
  ): Promise<AuthUser> {
    const email = validateEmail(emailRaw);
    const role = validateRole(roleRaw);

    return this.db.transaction(async (): Promise<AuthUser> => {
      const user = await this.findUserByEmail(email);
      if (!user) {
        throw new AuthError(404, `No user found with email "${email}"`);
      }

      if (user.role === "owner") {
        throw new AuthError(409, "The owner role cannot be changed");
      }

      if (user.role === role) {
        return this.publicUser(user);
      }

      if (role === "user") {
        if ((await this.countAdmins()) <= 1) {
          const self =
            actorEmail !== undefined &&
            actorEmail.toLowerCase() === email.toLowerCase();
          throw new AuthError(
            409,
            self
              ? `Cannot demote yourself ("${email}"): you are the last admin. Promote another user first.`
              : `Cannot demote "${email}": they are the last admin. Promote another user first.`
          );
        }
      }

      await this.db.update(
        "_users",
        { role },
        [{ column: "email", operator: "eq", value: email }]
      );

      const updated = await this.findUserByEmail(email);
      return this.publicUser(updated!);
    });
  }

  async setRoleById(
    idRaw: unknown,
    roleRaw: unknown,
    actorEmail?: string
  ): Promise<AuthUser> {
    const id = parseUserId(idRaw);
    const user = await this.findUserById(id);
    if (!user) {
      throw new AuthError(404, `No user found with id ${id}`);
    }
    return this.setRole(user.email, roleRaw, actorEmail);
  }
}
