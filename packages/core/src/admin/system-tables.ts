import type { IntrospectedTable } from "@localbase/shared";

/**
 * System tables — tables that LocalBase owns internally and that the admin
 * row-CRUD endpoints must refuse to write to directly.
 *
 * Why gate these?
 * ───────────────
 * The admin's generic row endpoints do raw INSERT/UPDATE/DELETE through the
 * Database class. If we allowed writes to system tables through those
 * endpoints, an admin could:
 *
 *   - PATCH `_users` SET password_hash = 'plain' … and break login (the
 *     hash format would not match what `hashPassword` produces).
 *   - PATCH `_users` SET role = 'admin' … and bypass the `setRole` flow
 *     (which also needs to invalidate existing JWTs).
 *   - DELETE `_sessions` … and silently sign out the world.
 *
 * The correct path for these mutations is the typed helpers on `Auth`
 * (and, in a later phase, `Storage`). The admin SPA will use dedicated
 * endpoints (`/_api/admin/users/...`, etc.) in M5. Until those land, the
 * generic row endpoints stay closed for system tables.
 *
 * Reads are still allowed — the admin needs to *see* the data, and there
 * is no integrity risk in showing it. The schema viewer also surfaces
 * system tables (with a `system: true` flag) so the admin can see them.
 *
 * Adding to this set
 * ──────────────────
 * Whenever a new subsystem (Storage, Jobs, etc.) introduces a `_`-prefixed
 * table, add it here. Tests assert that all tables with names starting
 * with `_` are flagged as system — that way an accidental gap is caught.
 */
export const SYSTEM_TABLES: ReadonlySet<string> = new Set([
  // Auth subsystem — owned by packages/core/src/auth/schema.ts
  "_users",
  "_sessions",

  // Storage subsystem — owned by Phase 9 (not yet implemented).
  // Listed here preemptively so the gate is ready the day P9 lands.
  "_files",

  // Jobs subsystem — owned by Phase 11 (not yet implemented).
  "_job_runs",
]);

/**
 * Returns true for any table LocalBase owns internally. We treat *any*
 * `_`-prefixed table as a system table — that's the convention the
 * existing code uses (`resetDatabase` already filters these out so user
 * resets never wipe the auth subsystem).
 *
 * Keeping the explicit `SYSTEM_TABLES` set above is still valuable: it
 * lets us tighten the policy per-table (e.g. allow reads of `_files` but
 * forbid deletes until P9 ships its own admin endpoint) without changing
 * the public classification rule.
 */
export function isSystemTable(tableName: string): boolean {
  if (tableName.startsWith("_")) return true;
  return SYSTEM_TABLES.has(tableName);
}

/**
 * Throws an `AdminError` (a 403-shaped error) when the given table is a
 * system table. The admin router uses this to short-circuit writes before
 * they hit the Database class.
 */
export class AdminError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function assertNotSystemTable(tableName: string): void {
  if (isSystemTable(tableName)) {
    throw new AdminError(
      403,
      `Direct writes to "${tableName}" are not allowed through the admin row ` +
        `API. Use the dedicated admin endpoint for this resource ` +
        `(e.g. /_api/admin/users for _users, /_api/admin/files for _files).`
    );
  }
}

/**
 * Throws an `AdminError` (403) when the given table is a virtual table or one
 * of its shadow tables. Virtual tables (`CREATE VIRTUAL TABLE`, e.g. fts5) and
 * their backing shadow tables (`ft_content`, `ft_data`, ...) are read-only
 * through the admin row API: writing to them directly corrupts the index and
 * sidesteps the module's own update path. Reads stay allowed.
 */
export function assertNotVirtualTable(table: IntrospectedTable): void {
  if (table.virtual) {
    throw new AdminError(
      403,
      `"${table.name}" is a virtual table and is read-only through the admin ` +
        `row API.`
    );
  }
}
