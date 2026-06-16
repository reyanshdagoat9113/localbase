// Admin subsystem (M1).
//
// Re-exports the public surface of the admin package: the JSON API router,
// the static SPA mount, schema introspection, and the system-tables policy.
// See LOCALBASE-ADMIN-UI.md for the full plan.

export { createAdminRouter } from "./router.js";
export { mountAdminStatic, findAdminDistPath } from "./static.js";
export { introspect } from "./introspect.js";
export {
  SYSTEM_TABLES,
  isSystemTable,
  assertNotSystemTable,
  AdminError,
} from "./system-tables.js";
