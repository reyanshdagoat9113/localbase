import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fsp from "node:fs/promises";
import nodePath from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { Database } from "./db.js";

/**
 * Manifest format version. Bumped only on a breaking change to the layout
 * (e.g. renaming a field, changing how the DB is stored). Additive changes
 * should keep `1` and extend the object so older restores keep working.
 */
export const BACKUP_MANIFEST_VERSION = 1;

/**
 * Filename of the SQLite database inside a backup directory. Kept constant
 * so a restore always knows where to find it, regardless of the live file's
 * original name (which may be `db.sqlite`, `data.db`, etc.).
 */
export const BACKUP_DB_FILENAME = "database.db";

/**
 * Subdirectory inside a backup directory that mirrors the live
 * `<dataDir>/storage/` tree.
 */
export const BACKUP_STORAGE_DIRNAME = "storage";

export type BackupErrorCode = "integrity" | "checksum" | "manifest" | "io";

/**
 * Typed error raised by {@link restoreBackup} (and, less commonly,
 * {@link createBackup}) when something is wrong with the backup or the live
 * data could not be replaced safely. The `code` lets callers — including the
 * CLI — distinguish "the backup is bad" from "the live data must not be
 * touched" without parsing the message.
 */
export class BackupError extends Error {
  code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/** One checksummed file inside a {@link BackupManifest}. */
export interface BackupManifestEntry {
  /**
   * POSIX-style (forward-slash) path relative to the backup directory root.
   * Never absolute, never contains `..` — verified on restore to prevent
   * path traversal out of the backup directory.
   */
  path: string;
  /** SHA-256 hex digest of the file's bytes. */
  sha256: string;
  /** File size in bytes. */
  size: number;
}

/**
 * The manifest written to `manifest.json` at the root of every backup.
 * Captures the durable SQLite settings at backup time and a SHA-256 of every
 * included file so a restore can detect bit-rot, truncation, or tampering
 * before it touches live data.
 */
export interface BackupManifest {
  version: typeof BACKUP_MANIFEST_VERSION;
  /** ISO-8601 timestamp the backup was taken. */
  createdAt: string;
  /** LocalBase version that produced the backup, for future migration. */
  tool: string;
  /** Relative filename of the SQLite database file inside the backup dir. */
  database: string;
  /** The SQLite PRAGMA settings captured at backup time. */
  pragmas: {
    journalMode: string;
    synchronous: string | number;
    busyTimeout: number;
    foreignKeys: string | number | boolean;
  };
  /** SHA-256 hex digest of the manifest's own database file (redundant with
   * the matching entry in `files`, but surfaced for quick inspection). */
  databaseSha256: string;
  /** Every checksummed file, including the database file and all storage. */
  files: BackupManifestEntry[];
}

/** Result of {@link createBackup}. */
export interface BackupResult {
  /** Absolute path to the created backup directory. */
  dir: string;
  /** The manifest written to the backup. */
  manifest: BackupManifest;
  /** Number of files copied (database + storage files). */
  fileCount: number;
}

/** Result of {@link restoreBackup}. */
export interface RestoreResult {
  /** Number of files restored (database + storage files). */
  fileCount: number;
}

// ─── createBackup ──────────────────────────────────────────────────────

/**
 * Create a LocalBase backup.
 *
 * A backup is a self-contained directory containing:
 *   - `database.db` — the SQLite database copied via the online backup API
 *     (safe to run while the server is up), taken after a WAL checkpoint so
 *     the snapshot is complete without the `-wal` sidecar.
 *   - `storage/` — a recursive copy of `<dataDir>/storage/`, so uploaded
 *     files are never orphaned from their `_files` metadata rows.
 *   - `manifest.json` — version, timestamp, the captured PRAGMA settings,
 *     and a SHA-256 + size of every included file.
 *
 * The backup directory is created fresh; any existing directory at
 * `destDir` is reused but its previous contents are NOT cleared (caller is
 * expected to point at a fresh path — the CLI does).
 */
export async function createBackup(opts: {
  database: Database;
  destDir: string;
}): Promise<BackupResult> {
  const { database, destDir } = opts;
  const db = database.sqliteRaw();

  // Force a WAL checkpoint (TRUNCATE) before the snapshot so every committed
  // page is folded back into the main file and the `-wal` is reset to zero
  // length. The backup API then copies a self-contained main file — without
  // this, restoring only the `.db` would lose the latest committed
  // transactions that still lived in the WAL. We ignore the row result; a
  // non-fatal checkpoint (e.g. nothing to do) still leaves us consistent.
  db.pragma("wal_checkpoint(TRUNCATE)");

  // Lay out the backup directory: <destDir>/{database.db, storage/, manifest.json}.
  await fsp.mkdir(destDir, { recursive: true });
  const storageDest = nodePath.join(destDir, BACKUP_STORAGE_DIRNAME);
  await fsp.mkdir(storageDest, { recursive: true });

  // Copy the live SQLite database into the backup using the online backup
  // API. better-sqlite3's `.backup()` uses SQLite's incremental backup,
  // which takes a consistent snapshot of the main file without blocking
  // readers and without needing the process to be quiesced. The destination
  // is written fresh; an existing file at that path is overwritten.
  const sqliteDest = nodePath.join(destDir, BACKUP_DB_FILENAME);
  await db.backup(sqliteDest);

  // Capture the durable PRAGMA settings at backup time. `journal_mode` is
  // read with simple:true so it comes back as the bare mode string.
  const journalMode = String(db.pragma("journal_mode", { simple: true }));
  const synchronous = db.pragma("synchronous", { simple: true }) as
    | string
    | number;
  const busyTimeout = Number(
    db.pragma("busy_timeout", { simple: true })
  );
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as
    | string
    | number
    | boolean;

  // Copy the storage tree (<dataDir>/storage/) into the backup so uploaded
  // files travel with their `_files` metadata rows. If no files have ever
  // been written the source dir may not exist yet — that's fine, the backup
  // simply has an empty `storage/`.
  const storageSrc = nodePath.join(database.getDataDir(), "storage");
  const copiedRelPaths: string[] = [];
  if (await pathExists(storageSrc)) {
    copiedRelPaths.push(...(await copyDir(storageSrc, storageDest)));
  }

  // Build the manifest. The database file is the first entry so it is easy
  // to find in diffs; storage files follow with their storage/… paths.
  const entries: BackupManifestEntry[] = [];
  const dbEntry = await hashFile(sqliteDest);
  entries.push({ path: BACKUP_DB_FILENAME, ...dbEntry });
  for (const rel of copiedRelPaths.sort()) {
    const abs = nodePath.join(storageDest, rel);
    const h = await hashFile(abs);
    // Store storage paths as storage/<...> relative to the backup root.
    entries.push({
      path: `${BACKUP_STORAGE_DIRNAME}/${rel.split(nodePath.sep).join("/")}`,
      ...h,
    });
  }

  const manifest: BackupManifest = {
    version: BACKUP_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    tool: `localbase-core`,
    database: BACKUP_DB_FILENAME,
    pragmas: { journalMode, synchronous, busyTimeout, foreignKeys },
    databaseSha256: dbEntry.sha256,
    files: entries,
  };

  await fsp.writeFile(
    nodePath.join(destDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  return { dir: destDir, manifest, fileCount: entries.length };
}

// ─── restoreBackup ─────────────────────────────────────────────────────

/**
 * Restore a LocalBase backup over live data.
 *
 * Operates purely on file paths — there must be NO running server holding the
 * live database open. The CLI guards this; calling this against an open
 * database will likely fail with a locked-file error.
 *
 * Safety contract:
 *   1. Read + structurally validate the manifest (`manifest` code).
 *   2. Re-hash every listed file and compare to the manifest (`checksum`).
 *   3. Open the backup's database read-only and run `PRAGMA integrity_check`
 *      (`integrity`).
 *   If ANY of these fail, a {@link BackupError} is thrown and the live data
 *   is left completely untouched.
 *
 * Only after all checks pass does the live data move:
 *   - The SQLite file is replaced atomically (temp in the same dir, fsync,
 *     rename) and its stale `-wal`/`-shm` sidecars are set aside first and
 *     removed after, so an interrupted restore can never pair a fresh main
 *     file with an old WAL.
 *   - The `storage/` tree is swapped atomically: live storage is moved aside,
 *     the backup's tree is copied into a sibling temp and renamed into
 *     place, then the aside is deleted. On any error the aside is moved back.
 *
 * The backup directory is never consumed — copying (not moving) the backup's
 * storage means the same backup can be restored again.
 */
export async function restoreBackup(opts: {
  backupDir: string;
  dbPath: string;
  dataDir: string;
}): Promise<RestoreResult> {
  const { backupDir, dbPath, dataDir } = opts;

  // 1. Read + validate the manifest.
  const manifest = await readManifest(backupDir);

  // 2. Verify every file's SHA-256 against the manifest BEFORE touching live
  //    data. This also enforces no path escapes the backup directory.
  await verifyChecksums(backupDir, manifest);

  // 3. Open the backup's database read-only and run integrity_check. The
  //    backup file is post-checkpoint so opening it is safe; readonly guards
  //    against any accidental write.
  const backupDbPath = nodePath.join(backupDir, manifest.database);
  await verifyIntegrity(backupDbPath);

  // ── All checks passed. Begin the atomic cutover. ──

  const dbDir = nodePath.dirname(dbPath);
  await fsp.mkdir(dbDir, { recursive: true });

  // 4. Atomically replace the live SQLite file.
  //    a. Move the live `-wal`/`-shm` aside FIRST. If a previous server
  //       process was killed (not stopped cleanly) these may contain
  //       pending pages for the OLD database; pairing them with the new main
  //       file would corrupt it on the next open. Moving them aside before
  //       the rename closes that window: the worst case is that an
  //       interrupted restore leaves the new main file with NO wal, which is
  //       safe (SQLite rebuilds it).
  const walAside = await moveAsideIfExists(`${dbPath}-wal`);
  const shmAside = await moveAsideIfExists(`${dbPath}-shm`);
  try {
    await atomicReplaceFile(backupDbPath, dbPath);
  } catch (err) {
    // Roll the sidecars back into place; the live main file was not replaced.
    await restoreAside(walAside, `${dbPath}-wal`);
    await restoreAside(shmAside, `${dbPath}-shm`);
    throw toBackupError(err, "io", `Failed to replace database file: ${errMsg(err)}`);
  }

  //    b. The new main file is in place and self-contained (post-checkpoint).
  //       Drop the old sidecars.
  await safeRemove(walAside?.path);
  await safeRemove(shmAside?.path);

  // 5. Atomically swap the storage tree.
  const storageDest = nodePath.join(dataDir, "storage");
  try {
    await atomicSwapStorage(
      nodePath.join(backupDir, BACKUP_STORAGE_DIRNAME),
      storageDest
    );
  } catch (err) {
    // The database has already been replaced at this point. We do not try to
    // roll the database back (that would risk a half-rolled-back state);
    // instead surface the error loudly. The DB is consistent; only the
    // storage swap failed and the live storage was either left in place or
    // moved aside adjacent to `storageDest`.
    throw toBackupError(
      err,
      "io",
      `Database was restored, but the storage swap failed: ${errMsg(
        err
      )}. Inspect ${nodePath.dirname(storageDest)} and re-run restore.`
    );
  }

  return { fileCount: manifest.files.length };
}

// ─── helpers ───────────────────────────────────────────────────────────

/** Best-effort existence check. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the SHA-256 hex digest and byte size of a file by streaming it.
 * Streaming keeps memory bounded for large storage objects.
 */
function hashFile(absPath: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), size }));
  });
}

/**
 * Recursively copy `src` into `dest` (which must already exist), returning
 * the list of copied file paths relative to `dest` using the platform
 * separator. Empty subdirectories are reproduced so the tree mirrors source.
 */
async function copyDir(
  src: string,
  dest: string
): Promise<string[]> {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  const relFiles: string[] = [];
  for (const entry of entries) {
    const srcPath = nodePath.join(src, entry.name);
    const destPath = nodePath.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(destPath, { recursive: true });
      const nested = await copyDir(srcPath, destPath);
      relFiles.push(
        ...nested.map((n) => `${entry.name}${nodePath.sep}${n}`)
      );
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      relFiles.push(entry.name);
    }
    // Symlinks / special files are skipped deliberately to avoid copying
    // anything outside the storage tree.
  }
  return relFiles;
}

/** Read and structurally validate the manifest from a backup directory. */
async function readManifest(backupDir: string): Promise<BackupManifest> {
  let raw: string;
  try {
    raw = await fsp.readFile(
      nodePath.join(backupDir, "manifest.json"),
      "utf8"
    );
  } catch (err) {
    throw new BackupError(
      "manifest",
      `Could not read manifest.json in ${backupDir}: ${errMsg(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BackupError(
      "manifest",
      `manifest.json is not valid JSON: ${errMsg(err)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new BackupError("manifest", "manifest.json must be a JSON object");
  }
  const m = parsed as Partial<BackupManifest>;
  if (m.version !== BACKUP_MANIFEST_VERSION) {
    throw new BackupError(
      "manifest",
      `Unsupported manifest version: expected ${BACKUP_MANIFEST_VERSION}, got ${String(
        m.version
      )}`
    );
  }
  if (typeof m.database !== "string" || m.database.length === 0) {
    throw new BackupError("manifest", "manifest.database must be a non-empty string");
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw new BackupError(
      "manifest",
      "manifest.files must be a non-empty array"
    );
  }

  // Validate each entry's shape and that no path escapes the backup dir.
  // This is the path-traversal guard: paths must be relative and contained.
  const seen = new Set<string>();
  for (const entry of m.files as BackupManifestEntry[]) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.size !== "number"
    ) {
      throw new BackupError(
        "manifest",
        `manifest.files entry is malformed: ${JSON.stringify(entry)}`
      );
    }
    if (!isSafeRelativePath(entry.path)) {
      throw new BackupError(
        "manifest",
        `manifest.files entry path is unsafe (absolute or escapes the backup dir): "${entry.path}"`
      );
    }
    if (entry.sha256.length !== 64 || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      throw new BackupError(
        "manifest",
        `manifest.files entry has an invalid SHA-256 digest: "${entry.path}"`
      );
    }
    if (seen.has(entry.path)) {
      throw new BackupError(
        "manifest",
        `manifest.files lists duplicate path: "${entry.path}"`
      );
    }
    seen.add(entry.path);
  }

  return m as BackupManifest;
}

/**
 * Re-hash every file listed in the manifest and compare to the recorded
 * digest + size. Throws a `checksum` BackupError on any mismatch, before
 * any live data is touched.
 */
async function verifyChecksums(
  backupDir: string,
  manifest: BackupManifest
): Promise<void> {
  for (const entry of manifest.files) {
    const abs = nodePath.join(backupDir, ...entry.path.split("/"));
    // `entry.path` was validated relative + contained, but re-check the
    // resolved absolute path stays under backupDir to be defensive.
    if (!isInside(backupDir, abs)) {
      throw new BackupError(
        "checksum",
        `Refusing to read outside the backup directory: "${entry.path}"`
      );
    }
    let actual;
    try {
      actual = await hashFile(abs);
    } catch (err) {
      throw new BackupError(
        "checksum",
        `Could not read backup file "${entry.path}": ${errMsg(err)}`
      );
    }
    if (actual.size !== entry.size) {
      throw new BackupError(
        "checksum",
        `Size mismatch for "${entry.path}": manifest=${entry.size}, actual=${actual.size}`
      );
    }
    if (actual.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new BackupError(
        "checksum",
        `SHA-256 mismatch for "${entry.path}": manifest=${entry.sha256}, actual=${actual.sha256}`
      );
    }
  }
}

/**
 * Open the backup database read-only and run `PRAGMA integrity_check`. A
 * healthy database returns the single row "ok"; anything else is treated as
 * corruption and the restore is refused. Opening read-only guarantees we
 * can never mutate the backup even if a future change to this routine is
 * buggy.
 */
function verifyIntegrity(backupDbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let conn: BetterSqlite3.Database;
    try {
      conn = new BetterSqlite3(backupDbPath, { readonly: true });
    } catch (err) {
      reject(
        new BackupError(
          "integrity",
          `Could not open backup database for integrity check: ${errMsg(err)}`
        )
      );
      return;
    }
    try {
      const rows = conn.pragma("integrity_check") as Array<{
        integrity_check?: string;
      }>;
      const ok =
        rows.length === 1 &&
        String(rows[0]?.integrity_check ?? "").toLowerCase() === "ok";
      if (!ok) {
        reject(
          new BackupError(
            "integrity",
            `integrity_check failed: ${JSON.stringify(rows)}`
          )
        );
        return;
      }
      resolve();
    } catch (err) {
      reject(
        new BackupError(
          "integrity",
          `integrity_check could not be run: ${errMsg(err)}`
        )
      );
    } finally {
      try {
        conn.close();
      } catch {
        // best-effort close
      }
    }
  });
}

/**
 * Atomically replace `dest` with the contents of `src` by copying into a
 * sibling temp file, fsyncing, then renaming over `dest`. The temp lives in
 * the same directory so the final rename is atomic on the same filesystem.
 * `src` is never modified (the backup is preserved).
 */
async function atomicReplaceFile(src: string, dest: string): Promise<void> {
  const dir = nodePath.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = nodePath.join(
    dir,
    `.${nodePath.basename(dest)}.restore.${randomToken()}`
  );
  try {
    await fsp.copyFile(src, tmp);
    await fsyncFile(tmp);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await safeRemove(tmp);
    throw err;
  }
}

/**
 * Swap the live storage directory for the backup's storage directory
 * atomically (on the live side):
 *   1. Copy the backup storage into a sibling temp (preserves the backup).
 *   2. Move the live storage aside (same FS → atomic rename).
 *   3. Rename the temp into place (same FS → atomic rename).
 *   4. Recursively delete the aside.
 * On any error the aside is moved back so live storage is restored to its
 * pre-restore state.
 */
async function atomicSwapStorage(
  backupStorage: string,
  liveStorage: string
): Promise<void> {
  const parent = nodePath.dirname(liveStorage);
  await fsp.mkdir(parent, { recursive: true });

  const tmp = nodePath.join(
    parent,
    `.storage.restore.${randomToken()}`
  );
  const aside = nodePath.join(
    parent,
    `.storage.old.${randomToken()}`
  );

  // 1. Stage the new tree in a sibling temp. If this fails, nothing live has
  //    moved yet.
  try {
    await fsp.mkdir(tmp, { recursive: true });
    if (await pathExists(backupStorage)) {
      await copyDir(backupStorage, tmp);
      await fsyncDirContents(tmp);
    }
  } catch (err) {
    await safeRemove(tmp);
    throw err;
  }

  // 2. Move the live storage aside. Missing live storage is fine (nothing
  //    uploaded yet) — we just skip the aside step.
  let liveMovedAside = false;
  try {
    if (await pathExists(liveStorage)) {
      await fsp.rename(liveStorage, aside);
      liveMovedAside = true;
    }
    // 3. Promote the staged tree into place.
    await fsp.rename(tmp, liveStorage);
    await fsyncDir(parent);
  } catch (err) {
    // Roll back: if the live tree was moved aside, put it back; otherwise
    // remove whatever landed at liveStorage so we don't leave a partial tree.
    if (liveMovedAside) {
      try {
        await safeRemove(liveStorage);
        await fsp.rename(aside, liveStorage);
      } catch {
        // best-effort; the original tree is still at `aside`
      }
    }
    await safeRemove(tmp);
    throw err;
  }

  // 4. Cutover succeeded; delete the old live tree.
  await safeRemove(aside);
}

/**
 * If `target` exists, rename it to a sibling temp and return that temp path
 * so it can be restored or deleted later. Returns null if it didn't exist.
 */
async function moveAsideIfExists(
  target: string
): Promise<{ path: string } | null> {
  if (!(await pathExists(target))) return null;
  const aside = `${target}.aside.${randomToken()}`;
  await fsp.rename(target, aside);
  return { path: aside };
}

/** Move an aside file back to its original target (best-effort rollback). */
async function restoreAside(
  aside: { path: string } | null,
  target: string
): Promise<void> {
  if (!aside) return;
  try {
    await fsp.rename(aside.path, target);
  } catch {
    // best-effort; the original is still at aside.path
  }
}

/** Remove a path if it exists, ignoring "not found" errors. */
async function safeRemove(p: string | undefined): Promise<void> {
  if (!p) return;
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Open a file, fsync its fd, and close it. */
async function fsyncFile(p: string): Promise<void> {
  let fd: fsp.FileHandle | undefined;
  try {
    fd = await fsp.open(p, "r+");
    await fd.sync();
  } finally {
    try {
      await fd?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Best-effort fsync of a directory's own metadata so a rename within it is
 * durable across a crash. May no-op on platforms that don't permit opening a
 * directory for sync; failures are swallowed because durability here is best
 * effort (the rename is still atomic in-memory).
 */
async function fsyncDir(dir: string): Promise<void> {
  let fd: fsp.FileHandle | undefined;
  try {
    fd = await fsp.open(dir, "r");
    await fd.sync();
  } catch {
    // not all platforms/fs permit syncing a directory fd
  } finally {
    try {
      await fd?.close();
    } catch {
      // ignore
    }
  }
}

/** Recursively fsync every file under `root` (storage durability on copy). */
async function fsyncDirContents(root: string): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const p = nodePath.join(root, entry.name);
    if (entry.isDirectory()) {
      await fsyncDirContents(p);
    } else if (entry.isFile()) {
      await fsyncFile(p);
    }
  }
  await fsyncDir(root);
}

/**
 * A relative path is safe iff it is not absolute and resolving it never
 * climbs above the base (no `..` segment resolves outside). We split on both
 * separators because Windows paths may arrive with backslashes.
 */
function isSafeRelativePath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (nodePath.isAbsolute(rel)) return false;
  // Normalize on forward slashes (the on-disk manifest format), then also
  // reject backslashes by treating them as separators.
  const normalized = rel.replace(/\\/g, "/");
  const parts = normalized.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) return false;
      continue;
    }
    depth++;
  }
  return depth > 0;
}

/** True iff `child` resolves to a path at or under `base`. */
function isInside(base: string, child: string): boolean {
  const rel = nodePath.relative(base, child);
  return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

/** Short random token for temp/aside suffixes. */
function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize an unknown error into a message string. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrap a thrown value as a BackupError, preserving an existing BackupError
 * unchanged. Non-BackupError throws become `fallbackCode`.
 */
function toBackupError(
  err: unknown,
  fallbackCode: BackupErrorCode,
  message: string
): BackupError {
  if (err instanceof BackupError) return err;
  return new BackupError(fallbackCode, message);
}

/**
 * Best-effort probe of whether the SQLite file at `dbPath` is currently held
 * open by another process (e.g. a running LocalBase server). Returns `true`
 * when the file is locked and a restore should be refused, `false` when it
 * appears safe to proceed.
 *
 * Used by the CLI to refuse a restore against a live server before any data
 * moves. This is advisory: some platforms/filesystems don't surface SQLite's
 * byte-range locks as a busy open, so callers should still print a warning.
 * If the file does not exist, returns `false` (nothing to lock).
 */
export function isDatabaseLocked(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let conn: BetterSqlite3.Database | undefined;
  try {
    // timeout: 0 -> fail immediately if locked, rather than blocking.
    conn = new BetterSqlite3(dbPath, { timeout: 0 });
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /BUSY|LOCKED|EBUSY|unable to open/i.test(msg);
  } finally {
    try {
      conn?.close();
    } catch {
      // ignore
    }
  }
}
