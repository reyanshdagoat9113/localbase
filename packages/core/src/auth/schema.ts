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
};
