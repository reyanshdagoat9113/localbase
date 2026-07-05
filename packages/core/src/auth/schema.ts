import type { DatabaseSchema } from "@localbase/shared";

/**
 * System tables provisioned automatically by LocalBase when `auth.enabled`
 * is true. The leading underscore is meaningful: `resetDatabase()` filters
 * out tables whose name starts with `_`, so user resets never wipe the
 * auth subsystem.
 *
 * These tables are added to the migration schema by the Database class, so
 * the user never has to declare them in their `localbase.config.ts`.
 */
export const AUTH_SCHEMA: DatabaseSchema = {
  _users: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    email: { type: "text", nullable: false, unique: true },
    password_hash: { type: "text", nullable: false },
    /**
     * User role: `"user"` (default), `"admin"`, or the bootstrap-only `"owner"`.
     *
     * Added in Phase 10/M2. For databases created before this column
     * existed, the additive migration adds it via
     * `ALTER TABLE _users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
     * so every pre-existing row becomes a regular user. Promote the first
     * admin with `localbase admin:promote <email>`.
     */
    role: { type: "text", default: "'user'", nullable: false },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
  _sessions: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    user_id: {
      type: "integer",
      nullable: false,
      references: { table: "_users", column: "id" },
    },
    token: { type: "text", nullable: false, unique: true },
    expires_at: { type: "text", nullable: false },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
  _admin_requests: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    email: { type: "text", nullable: false, unique: true },
    password_hash: { type: "text", nullable: false },
    // Logical reference to _users.id for promotion requests. This is
    // intentionally not a SQL FOREIGN KEY: existing installations already
    // have _admin_requests, and SQLite cannot add a REFERENCES column through
    // ALTER TABLE. Auth.approveAdminRequest validates the user explicitly.
    user_id: { type: "integer" },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
};
