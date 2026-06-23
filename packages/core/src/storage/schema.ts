import type { DatabaseSchema } from "@localbase/shared";

/**
 * System table provisioned automatically by LocalBase for the storage
 * subsystem. The leading underscore is meaningful: `resetDatabase()` filters
 * out tables whose name starts with `_`, so user resets never wipe file
 * metadata.
 *
 * The `_files` table maps user-facing file metadata to the server-generated
 * UUID stored on disk. The original filename is never used as a filesystem
 * path component.
 */
export const STORAGE_SCHEMA: DatabaseSchema = {
  _files: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    bucket: { type: "text", nullable: false },
    stored_name: { type: "text", nullable: false },
    original_name: { type: "text", nullable: false },
    size: { type: "integer", nullable: false },
    mime: { type: "text" },
    uploaded_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
};
