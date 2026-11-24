import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Database } from "./db.js";
import { createBackup, restoreBackup, BackupError } from "./backup.js";
import type { DatabaseSchema } from "@localbase/shared";

// ─── Test schema ────────────────────────────────────────────────────────

const schema: DatabaseSchema = {
  notes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    body: { type: "text", nullable: false },
    created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
  },
};

// ─── temp-dir helpers ──────────────────────────────────────────────────

/** Each test gets its own isolated project dir to avoid cross-test bleed. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), "localbase-backup-"));
}

/** Read a file's bytes (used to snapshot/compare the live db). */
function readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

/** Flip a byte in the middle of a file to simulate on-disk corruption. */
async function flipMiddleByte(p: string): Promise<void> {
  const buf = await fsp.readFile(p);
  if (buf.byteLength === 0) throw new Error(`cannot corrupt empty file ${p}`);
  const mid = Math.floor(buf.byteLength / 2);
  buf[mid] = (buf[mid] ^ 0xff) & 0xff;
  await fsp.writeFile(p, buf);
}

// ─── shared project factory ────────────────────────────────────────────

interface Project {
  /** Root temp dir for the project. */
  root: string;
  /** `.localbase/data.db` path. */
  dbPath: string;
  /** `.localbase/` data dir. */
  dbDir: string;
  /** The live Database instance (closed in cleanup). */
  db: Database;
}

/**
 * Spin up a fresh project: a temp dir with a `.localbase/` data dir and an
 * open Database. Mirrors how `localbase dev` lays things out on disk so the
 * backup/restore paths operate against realistic layout.
 */
async function makeProject(): Promise<Project> {
  const root = await makeTempDir();
  const dbDir = path.join(root, ".localbase");
  const dbPath = path.join(dbDir, "data.db");
  await fsp.mkdir(dbDir, { recursive: true });
  const db = await Database.open({ schema, path: dbPath, dataDir: dbDir });
  return { root, dbPath, dbDir, db };
}

const dirsToClean: string[] = [];

afterEach(async () => {
  // Best-effort cleanup of every temp dir created during a test.
  await Promise.all(
    dirsToClean.splice(0).map((d) =>
      fsp.rm(d, { recursive: true, force: true }).catch(() => {})
    )
  );
});

// Track a temp dir for cleanup (tests create several: project + backup).
function track<T extends string>(p: T): T {
  dirsToClean.push(p);
  return p;
}

// ─── Backup format / PRAGMA tests ──────────────────────────────────────

describe("backup: durable PRAGMAs are set on open", () => {
  it("sets journal_mode=wal, synchronous=NORMAL(1), busy_timeout=5000", async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), "lb-pragmas-")));
    const dbPath = path.join(root, "data.db");
    const db = await Database.open({ schema, path: dbPath, dataDir: root });
    try {
      const journalMode = String(db.sqliteRaw().pragma("journal_mode", { simple: true }));
      const synchronous = db.sqliteRaw().pragma("synchronous", { simple: true });
      const busyTimeout = Number(db.sqliteRaw().pragma("busy_timeout", { simple: true }));
      const foreignKeys = db.sqliteRaw().pragma("foreign_keys", { simple: true });

      assert.equal(journalMode.toLowerCase(), "wal");
      // NORMAL maps to the integer 1 in SQLite.
      assert.ok(
        synchronous === 1 || synchronous === "NORMAL" || synchronous === "1",
        `synchronous should be NORMAL(1), got ${String(synchronous)}`
      );
      assert.equal(busyTimeout, 5000);
      // foreign_keys must remain ON (the new PRAGMAs are additive to it).
      assert.ok(
        foreignKeys === 1 || foreignKeys === true || foreignKeys === "1",
        `foreign_keys should be ON, got ${String(foreignKeys)}`
      );
    } finally {
      await db.close();
    }
  });
});

describe("backup: manifest shape", () => {
  it("writes manifest.json with version, pragmas, checksums, and the db file", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "hello" });
    // Drop a real file into storage so it appears in the manifest.
    const storageRoot = path.join(project.dbDir, "storage", "uploads");
    await fsp.mkdir(storageRoot, { recursive: true });
    await fsp.writeFile(path.join(storageRoot, "file-a.bin"), Buffer.from("AAAA"));

    const result = await createBackup({ database: project.db, destDir: backupDir });

    // Manifest exists and parses.
    const manifestPath = path.join(backupDir, "manifest.json");
    assert.ok(fs.existsSync(manifestPath), "manifest.json should exist");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));

    assert.equal(manifest.version, 1);
    assert.equal(manifest.database, "database.db");
    assert.ok(manifest.createdAt);
    assert.equal(manifest.pragmas.journalMode.toLowerCase(), "wal");
    assert.equal(manifest.pragmas.busyTimeout, 5000);

    // The db file and the storage file are both listed with SHA-256 + size.
    const paths = manifest.files.map((f: { path: string }) => f.path).sort();
    assert.ok(paths.includes("database.db"));
    assert.ok(paths.includes("storage/uploads/file-a.bin"));
    assert.equal(result.fileCount, manifest.files.length);

    // database.db and storage/ both physically exist in the backup dir.
    assert.ok(fs.existsSync(path.join(backupDir, "database.db")));
    assert.ok(
      fs.existsSync(path.join(backupDir, "storage", "uploads", "file-a.bin"))
    );

    // databaseSha256 matches the database.db entry.
    const dbEntry = manifest.files.find(
      (f: { path: string }) => f.path === "database.db"
    );
    assert.equal(manifest.databaseSha256, dbEntry.sha256);

    await project.db.close();
  });
});

// ─── Round-trip ────────────────────────────────────────────────────────

describe("backup: round-trip (backup -> mutate -> restore)", () => {
  it("restores the ORIGINAL db rows and storage file after live mutation", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    // Baseline state: one row + one storage file.
    await project.db.insert("notes", { body: "original" });
    const storageFile = path.join(project.dbDir, "storage", "uploads", "pic.bin");
    await fsp.mkdir(path.dirname(storageFile), { recursive: true });
    await fsp.writeFile(storageFile, Buffer.from("original-bytes"));

    // Take the backup (online, server-up).
    await createBackup({ database: project.db, destDir: backupDir });

    // Close the live db so restore can operate on file paths alone.
    await project.db.close();

    // Mutate the live data AFTER the backup: add rows, delete the storage file.
    const mutator = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    mutator.insert("notes", { body: "after-backup-1" });
    mutator.insert("notes", { body: "after-backup-2" });
    await fsp.rm(storageFile, { force: true });
    mutator.close();

    // Sanity: the live DB now has 3 rows and the storage file is gone.
    let checker = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    assert.equal((await checker.select("notes")).length, 3);
    assert.ok(!fs.existsSync(storageFile));
    await checker.close();

    // Restore (server is stopped — purely file-path based).
    await restoreBackup({
      backupDir,
      dbPath: project.dbPath,
      dataDir: project.dbDir,
    });

    // Reopen and assert the ORIGINAL state is back: only the "original" row
    // and the storage file with its original bytes.
    checker = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    const rows = (await checker.select("notes")) as Array<{ body: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "original");
    await checker.close();

    assert.ok(fs.existsSync(storageFile), "storage file should be restored");
    const restoredBytes = await fsp.readFile(storageFile);
    assert.equal(restoredBytes.toString(), "original-bytes");

    // The live -wal/-shm sidecars were cleaned up by restore (post-checkpoint
    // backup means no wal is needed). The db file opens cleanly on its own.
    assert.ok(
      fs.existsSync(project.dbPath),
      "live db file should exist after restore"
    );
  });

  it("db row and its companion storage file are restored together", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    // Insert a row that "points at" a storage object (mirrors how _files +
    // on-disk objects relate). Both should survive the round-trip together.
    project.db.sqliteRaw()
      .prepare(`INSERT INTO "notes" ("body") VALUES (?)`)
      .run("points-at:uploads/companion.bin");
    const companion = path.join(project.dbDir, "storage", "uploads", "companion.bin");
    await fsp.mkdir(path.dirname(companion), { recursive: true });
    await fsp.writeFile(companion, Buffer.from("companion"));

    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Wipe live state entirely and restore.
    await fsp.rm(path.join(project.dbDir, "storage"), { recursive: true, force: true });

    await restoreBackup({
      backupDir,
      dbPath: project.dbPath,
      dataDir: project.dbDir,
    });

    // Both the DB row and the companion file are present together.
    assert.ok(fs.existsSync(companion), "companion storage file restored");
    const checker = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    const rows = (await checker.select("notes")) as Array<{ body: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "points-at:uploads/companion.bin");
    await checker.close();
  });
});

// ─── Atomicity: a refused restore leaves live data byte-for-byte intact ──

describe("backup: refused restore leaves live data untouched", () => {
  it("corrupt manifest -> BackupError(manifest), live db file byte-for-byte unchanged", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "keep-me" });
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Corrupt the manifest so it's invalid JSON.
    const manifestPath = path.join(backupDir, "manifest.json");
    await fsp.writeFile(manifestPath, "{ not valid json }}}");

    const before = readBytes(project.dbPath);

    await assert.rejects(
      () => restoreBackup({ backupDir, dbPath: project.dbPath, dataDir: project.dbDir }),
      (err: unknown) => err instanceof BackupError && err.code === "manifest"
    );

    const after = readBytes(project.dbPath);
    assert.deepEqual(after, before, "live db bytes must be unchanged");
  });

  it("checksum mismatch (altered storage file) -> BackupError(checksum), live data intact", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "keep-me" });
    const liveStorage = path.join(project.dbDir, "storage", "uploads", "doc.bin");
    await fsp.mkdir(path.dirname(liveStorage), { recursive: true });
    await fsp.writeFile(liveStorage, Buffer.from("payload"));
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Tamper with the BACKUP copy of the storage file so its SHA-256 no longer
    // matches the manifest. Integrity check would still pass on the db, so
    // this specifically exercises the checksum path.
    await fsp.writeFile(
      path.join(backupDir, "storage", "uploads", "doc.bin"),
      Buffer.from("tampered")
    );

    const before = readBytes(project.dbPath);
    const storageBefore = await fsp.readFile(liveStorage);

    await assert.rejects(
      () => restoreBackup({ backupDir, dbPath: project.dbPath, dataDir: project.dbDir }),
      (err: unknown) => err instanceof BackupError && err.code === "checksum"
    );

    assert.deepEqual(readBytes(project.dbPath), before);
    assert.deepEqual(await fsp.readFile(liveStorage), storageBefore);
    // Live storage tree is fully intact (still has the original file).
    assert.ok(fs.existsSync(liveStorage));
  });

  it("corrupt backup database -> BackupError(integrity), live data intact", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "keep-me" });
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Flip bytes in the BACKUP's database.db. We must also update the
    // manifest's recorded SHA-256 for that file to its new digest, otherwise
    // the checksum check fires first (still a valid refusal, but we want to
    // exercise the integrity_check path here). Recompute the manifest entry
    // so checksums pass and integrity_check is what catches the corruption.
    const backupDbPath = path.join(backupDir, "database.db");
    await flipMiddleByte(backupDbPath);
    const manifestPath = path.join(backupDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const { createHash } = await import("node:crypto");
    const newHash = createHash("sha256")
      .update(await fsp.readFile(backupDbPath))
      .digest("hex");
    const newSize = (await fsp.stat(backupDbPath)).size;
    const dbEntry = manifest.files.find(
      (f: { path: string }) => f.path === "database.db"
    );
    dbEntry.sha256 = newHash;
    dbEntry.size = newSize;
    manifest.databaseSha256 = newHash;
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const before = readBytes(project.dbPath);

    await assert.rejects(
      () => restoreBackup({ backupDir, dbPath: project.dbPath, dataDir: project.dbDir }),
      (err: unknown) => err instanceof BackupError && err.code === "integrity"
    );

    assert.deepEqual(readBytes(project.dbPath), before, "live db untouched");
  });

  it("manifest path traversal entry -> BackupError(manifest), refuses to read outside", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "keep-me" });
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Add a malicious entry that tries to escape the backup dir.
    const manifestPath = path.join(backupDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "../../../etc/passwd",
      sha256: "0".repeat(64),
      size: 0,
    });
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const before = readBytes(project.dbPath);
    await assert.rejects(
      () => restoreBackup({ backupDir, dbPath: project.dbPath, dataDir: project.dbDir }),
      (err: unknown) =>
        err instanceof BackupError && err.code === "manifest"
    );
    assert.deepEqual(readBytes(project.dbPath), before);
  });

  it("missing file in backup -> BackupError(checksum), live storage intact", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "keep-me" });
    const liveStorage = path.join(project.dbDir, "storage", "uploads", "gone.bin");
    await fsp.mkdir(path.dirname(liveStorage), { recursive: true });
    await fsp.writeFile(liveStorage, Buffer.from("here"));
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Delete a file from the BACKUP dir so verification can't read it.
    await fsp.rm(path.join(backupDir, "storage", "uploads", "gone.bin"));

    const before = readBytes(project.dbPath);
    await assert.rejects(
      () => restoreBackup({ backupDir, dbPath: project.dbPath, dataDir: project.dbDir }),
      (err: unknown) => err instanceof BackupError && err.code === "checksum"
    );
    assert.deepEqual(readBytes(project.dbPath), before);
    assert.ok(fs.existsSync(liveStorage), "live storage untouched");
  });
});

// ─── WAL sidecar handling ──────────────────────────────────────────────

describe("backup: restore cleans up stale WAL sidecars", () => {
  it("removes a leftover -wal/-shm so the new db opens without replaying the old one", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "snapshotted" });
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Simulate a server that was killed (not closed cleanly) by leaving a
    // stale -wal/-shm next to the live db. Restore must move these aside
    // BEFORE replacing the main file so the new db never pairs with them.
    await fsp.writeFile(`${project.dbPath}-wal`, Buffer.from("stale-wal"));
    await fsp.writeFile(`${project.dbPath}-shm`, Buffer.from("stale-shm"));

    await restoreBackup({
      backupDir,
      dbPath: project.dbPath,
      dataDir: project.dbDir,
    });

    // The stale sidecars are gone — the restored (post-checkpoint) db is
    // self-contained.
    assert.ok(!fs.existsSync(`${project.dbPath}-wal`));
    assert.ok(!fs.existsSync(`${project.dbPath}-shm`));
    // And no aside leftovers linger.
    const siblings = await fsp.readdir(project.dbDir);
    const aside = siblings.find((s) => s.includes(".aside."));
    assert.equal(aside, undefined, "no aside leftovers should remain");

    // The db opens cleanly and reflects the backup.
    const checker = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    const rows = (await checker.select("notes")) as Array<{ body: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "snapshotted");
    await checker.close();
  });
});

// ─── empty storage edge case ───────────────────────────────────────────

describe("backup: empty storage tree", () => {
  it("backs up and restores a project with no uploaded files", async () => {
    const project = await makeProject();
    track(project.root);
    const backupDir = track(path.join(project.root, "backup"));

    await project.db.insert("notes", { body: "no-files" });
    await createBackup({ database: project.db, destDir: backupDir });
    await project.db.close();

    // Add a stray file into live storage AFTER the backup, then restore —
    // restore should remove it (the backup had no storage files).
    const stray = path.join(project.dbDir, "storage", "uploads", "stray.bin");
    await fsp.mkdir(path.dirname(stray), { recursive: true });
    await fsp.writeFile(stray, Buffer.from("should-vanish"));

    await restoreBackup({
      backupDir,
      dbPath: project.dbPath,
      dataDir: project.dbDir,
    });

    assert.ok(!fs.existsSync(stray), "stray post-backup storage file should be gone");
    const checker = await Database.open({ schema, path: project.dbPath, dataDir: project.dbDir });
    const rows = (await checker.select("notes")) as Array<{ body: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "no-files");
    await checker.close();
  });
});

// Unused import guard: `before`/`after` kept available for future setup.
void before;
void after;
