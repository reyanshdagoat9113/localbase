# Backup and Recovery

Part of the [documentation index](./README.md). CLI: [`db backup` / `db restore`](./CLI.md#db).

Manual, local, online backups with checksum-verified restore. No automatic,
scheduled, remote, or encrypted backups exist yet.

---

## TL;DR

```bash
# Back up (safe to run while the server is up):
localbase db backup

# Stop the server, then restore:
localbase db restore backups/localbase-backup-20260706-120000
```

A backup is a **directory**, not a single file. It contains the SQLite
database, the uploaded-file storage tree, and a manifest with SHA-256
checksums of everything inside. Restoring verifies integrity **first** and
only then replaces the live data **atomically**.

---

## What a backup includes

A backup directory contains:

```
localbase-backup-20260706-120000/
  manifest.json       ← version, timestamp, PRAGMA settings, SHA-256 of every file
  database.db         ← SQLite database (copied via the online backup API, post-checkpoint)
  storage/            ← recursive copy of .localbase/storage/ (your uploaded files)
    avatars/
      3f9c….jpg
    uploads/
      a1b2….pdf
```

- **`database.db`** is copied with SQLite's own online backup API
  (`better-sqlite3` `db.backup(...)`), which takes a consistent snapshot
  without blocking readers. A WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`)
  is forced **before** the copy, so the snapshot is self-contained — it does
  not depend on a `-wal` sidecar.
- **`storage/`** mirrors `.localbase/storage/` exactly. Without it, the rows
  in the `_files` metadata table would point at objects that no longer exist,
  so storage files are first-class members of every backup.
- **`manifest.json`** records a SHA-256 and byte size for **every** included
  file, plus the durable SQLite PRAGMA settings, a format version, and a
  timestamp. Restore uses it to detect bit-rot, truncation, or tampering
  before touching live data.

The backup does **not** include:

- Other files in `.localbase/` (it is purpose-built: DB + storage only).
- Anything outside `.localbase/` (your code, `node_modules`, config).
- Any remote/cloud copy. The backup lives wherever you put it on local disk.

### Manifest shape

```json
{
  "version": 1,
  "createdAt": "2026-07-06T12:00:00.000Z",
  "tool": "localbase-core",
  "database": "database.db",
  "pragmas": {
    "journalMode": "wal",
    "synchronous": 1,
    "busyTimeout": 5000,
    "foreignKeys": 1
  },
  "databaseSha256": "ab12…(64 hex chars)",
  "files": [
    { "path": "database.db",              "sha256": "ab12…", "size": 12345 },
    { "path": "storage/avatars/3f9c….jpg", "sha256": "cd34…", "size": 90112 }
  ]
}
```

Paths in the manifest are POSIX-style (forward slashes) and are validated on
restore to never escape the backup directory.

---

## Backing up

```bash
localbase db backup [out]
```

- `[out]` is optional. Omit it to write a timestamped directory under
  `./backups/`, e.g. `backups/localbase-backup-20260706-120000`.
- **The server may stay running.** The backup uses the SQLite backup API,
  which is safe under concurrent reads. Writers are briefly gated only for
  the WAL checkpoint, which is milliseconds for a typical preview database.
- The backup is **local**. Copy it elsewhere (a different disk, your laptop,
  an external drive) yourself if you want off-machine durability — LocalBase
  will not do that for you.

Example with an explicit destination:

```bash
localbase db backup /mnt/external/snapshots/today
```

---

## Restoring

```bash
# 1. STOP the server first:
#    (Ctrl+C on `localbase dev` / `localbase studio`)
localbase db restore <path-to-backup-dir>
```

### The restore is verify-then-swap

Restore refuses to touch live data until it has proof the backup is sound:

1. **Read + validate** `manifest.json` (`manifest` errors). A missing,
   unparseable, wrong-version, or shape-invalid manifest aborts immediately.
2. **Verify every checksum** (`checksum` errors). Each file listed in the
   manifest is re-hashed and compared; a size or SHA-256 mismatch, a missing
   file, or a path that escapes the backup directory aborts immediately.
3. **Integrity-check the database** (`integrity` errors). The backup's
   `database.db` is opened **read-only** and `PRAGMA integrity_check` is run.
   Anything other than `ok` aborts immediately.

If any of those fail, restore throws a typed `BackupError` and **the live
database and storage are left completely untouched**.

Only after all checks pass does the cutover begin:

- **SQLite file:** the backed-up DB is copied to a sibling temp file in the
  same directory, `fsync`'d, then `rename`'d atomically over the live
  `data.db`. The live `-wal` / `-shm` sidecars are moved aside **before** the
  rename and deleted after, so the new main file can never be paired with a
  stale WAL from the old database.
- **Storage tree:** live `.localbase/storage/` is moved aside; the backup's
  `storage/` is copied into a sibling temp and `rename`'d into place; the
  old tree is deleted only after success. On any error the aside is moved
  back, restoring the previous storage state.

The backup directory is **not consumed** by a restore (storage is copied, not
moved), so the same backup can be restored again.

### Restore atomicity guarantee

> Before any check passes, **zero** live bytes change. After checks pass, the
> database file is replaced by a single atomic `rename`, and the storage tree
> is replaced by a single atomic `rename`; on any failure during the storage
> swap, the previous live storage is rolled back into place.

### The server MUST be stopped

Restore operates on file paths, not a live database handle. Restoring over a
running server would race with writes and could produce a torn copy. The CLI
makes a best-effort check (it tries to open the DB file with a zero timeout
and refuses if it comes back busy) and prints a prominent warning — but you
are responsible for ensuring the server is stopped.

---

## Durability settings

LocalBase opens its database with these PRAGMAs (set in `Database`, additive
to the existing `foreign_keys = ON`):

| PRAGMA | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Writers don't block readers; committed transactions survive an ordinary process crash (the `-wal` is replayed on the next open). Right for a long-running single-process server where admin/realtime/jobs read while user writes land. |
| `synchronous` | `NORMAL` | Under WAL, a commit is acknowledged without an `fsync` per transaction. A process crash never loses committed work; only a power-loss / OS crash can drop the last few commits, and it can **never corrupt** the database. The right tradeoff for a preview server. (Use `FULL` only if every transaction must survive a power cut.) |
| `busy_timeout` | `5000` | Wait up to 5s on a locked DB before raising `SQLITE_BUSY`. Covers the WAL-checkpoint window during backup and brief read/write contention in a single-process server. |
| `foreign_keys` | `ON` | Cascades and `RESTRICT` are enforced; set before migrations run. |

You can confirm these at any time:

```bash
sqlite3 .localbase/data.db "PRAGMA journal_mode; PRAGMA synchronous; PRAGMA busy_timeout; PRAGMA foreign_keys;"
```

### Crash recovery expectations

- **Clean stop** (`Ctrl+C` / `SIGTERM`): the server closes the DB, which
  checkpoints the WAL. The next open starts clean.
- **Killed process** (`kill -9`, power loss to the machine while the server
  ran): on the next open, SQLite replays the WAL forward to the last
  committed transaction and recovers. The database is never corrupted; the
  only possible loss is the very last handful of commits that had not yet
  reached the WAL (a power-loss-only scenario, given `synchronous = NORMAL`).
- **Disk full mid-write:** a write that cannot be persisted fails with an
  `SQLITE_FULL` error and the transaction is rolled back. Existing committed
  data is unaffected. Free space and re-run the operation.

---

## RPO / RTO

These are realistic expectations for a **single-process preview** database:

- **RPO (Recovery Point Objective) = the time since your last successful
  backup.** LocalBase does **not** schedule backups for you. If you back up
  hourly, your worst-case data loss on a catastrophic failure is up to one
  hour. If you never back up, your RPO is "everything since you started."
- **RTO (Recovery Time Objective) = copy-back time.** For typical preview
  databases (megabytes to a few gigabytes) on local disk, restore completes
  in **seconds to a few minutes** — dominated by copying the storage tree.
  A backup on a slow network mount will be slower.

There is **no automatic** mechanism here:

- **No scheduled backups.** You run `localbase db backup` when you want one
  (or wrap it in `cron` / `systemd` yourself).
- **No remote replication.** The backup is a local directory. Getting it off
  the host (a separate disk, object storage, your laptop) is your job.
- **No encryption-at-rest.** Backup files are plaintext on disk, including
  the SQLite database and uploaded files. Protect the filesystem permissions
  of your backup directory; do not copy unencrypted backups onto untrusted
  storage.

If any of these matter for your workload, LocalBase is not yet the right
tool — treat the preview server as disposable and re-seed from your real
backups.

---

## Programmatic use

The same logic is exported from `@localbase/core` for tooling or tests:

```ts
import { createBackup, restoreBackup, BackupError } from "@localbase/core";

// Online backup (server may be running):
const result = await createBackup({
  database,                 // an open Database instance
  destDir: "/srv/backups/today",
});

// Restore (server MUST be stopped; operates on paths only):
try {
  await restoreBackup({
    backupDir: "/srv/backups/today",
    dbPath: projectDir + "/.localbase/data.db",
    dataDir: projectDir + "/.localbase",
  });
} catch (err) {
  if (err instanceof BackupError) {
    // err.code is "manifest" | "checksum" | "integrity" | "io"
    // checksum/integrity/manifest => live data was NOT touched
  }
}
```

`BackupError.code`:

- `"manifest"` — missing/invalid/wrong-version manifest or unsafe path.
- `"checksum"` — a file's SHA-256 or size does not match the manifest.
- `"integrity"` — `PRAGMA integrity_check` on the backup DB did not return `ok`.
- `"io"` — a filesystem operation failed during the cutover (rare; the DB is
  verified before this stage).

For `manifest`, `checksum`, and `integrity`, the live database and storage
are guaranteed untouched.
