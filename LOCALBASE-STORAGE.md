# 📦 LocalBase Storage — Dedicated Plan

> **Status: complete (historical plan).** Phase 9 has shipped. Prefer the root
> [README](./README.md) “Storage” section for current usage. This file remains
> as the design record and security decision log.

> Pulled out of `LOCALBASE-POST-MVP.md` Phase 9 into its own plan.
> File uploads/downloads with bucket abstraction, private-by-default, signed URLs.

---

## 🎯 Why this was a priority

Storage was the last missing first-class data primitive. With it shipped, LocalBase covers the full backend quartet: **relational data** (MVP), **auth** (Phase 7), **realtime** (Phase 8), and **files** (Phase 9). Admin Studio includes a Storage browser.

**Axis clarification:** like Admin UI, Storage is a *perception/completeness* feature — it removes a "wait, it can't even store files?" objection more than it unlocks a new category. It also has a dangerous security surface (uploads, path traversal), so the dedicated-plan rigor was warranted.

---

## 📌 Thesis

A bucket-based file API at `http://localhost:5180/api/storage/:bucket` for upload/download/list/delete, backed by the local filesystem under the data dir. Buckets are private by default; private reads require auth (Phase 7) **or** a valid signed URL. Files are stored under a UUID name with the original name preserved as metadata and restored on download via `Content-Disposition`.

---

## ✅ Decision Record (locked — implemented as shipped)

| # | Decision | Proposed choice | Rationale |
|---|---|---|---|
| 1 | **Bucket model** | Auto-create on first upload; optionally pre-declared in config | Lowest friction (folders "just work"); config gives control when wanted; no separate `buckets` table for first cut |
| 2 | **Public vs private** | Per-bucket `public: boolean` (default `false`); private requires auth (Phase 7) **or** a valid signed URL | Auth exists now; private-by-default is the safe default; public buckets skip auth |
| 3 | **Filename strategy** | Generate a UUID `stored_name`, keep the original as `original_name` metadata; reject path separators | Prevents collisions + path traversal; original name restored on download via `Content-Disposition` |
| 4 | **Signed URLs** | HMAC-SHA256 over `bucket/stored_name\|expiry`, query params `?expires=&sig=`; dedicated storage secret (fallback to JWT secret) | Standard, short-lived, revocable by secret rotation; verify middleware checks expiry + signature |
| 5 | **Upload parsing + limits** | Hono native multipart (`c.req.parseBody`), stream to disk, configurable `maxFileSize` (default ~50 MB) | Avoids buffering large files in memory; no extra dependency |
| 6 | **Storage root** | `<data-dir>/storage/` (follows the `.localbase/` data dir) | Consistent with DB location; no new config surface |

> ✅ Locked as implemented. **Decision #2 (private-by-default) and #3 (UUID stored name)** remain security-critical — do not weaken them without a recorded reason.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Client: SDK  storage.from("avatars").upload(file)          │
│         fetch / signed URL <img src=...>                     │
└─────────────────────────────────────────────────────────────┘
                         │  multipart upload / GET
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Hono app (createServer)                                    │
│                                                             │
│   POST   /api/storage/:bucket            → upload (auth)    │
│   GET    /api/storage/:bucket/:filename  → download         │
│   DELETE /api/storage/:bucket/:filename  → delete (auth)    │
│   GET    /api/storage/:bucket            → list (auth)      │
│                                                             │
│   read gate: public bucket → open                           │
│              private bucket → requireAuth OR signed URL     │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Storage engine (packages/core)                             │
│   .save(bucket, file) → UUID stored_name, row in _files     │
│   .get(bucket, storedName) → stream                         │
│   .delete(bucket, storedName)                               │
│   .list(bucket)                                              │
│                                                             │
│  Disk:   <data-dir>/storage/<bucket>/<stored_name>          │
│  Metadata: _files table                                     │
└─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- Filenames on disk are **always** server-generated UUIDs. The user-supplied name never touches the filesystem — only `_files.original_name`.
- Every path is resolved against the storage root and **confirmed to stay inside it** (reject `..`, absolute paths, null bytes).
- Bucket names are validated against a strict allowlist (`[a-z0-9-]{1,63}`) before any directory operation.
- Writes go through the storage engine; the `_files` metadata row and the on-disk file are created/deleted together (delete-on-failure if the metadata insert fails).

---

## 🔐 Security Model

**Path traversal.** The only safe pattern is: never trust client-supplied filenames for filesystem paths. Generate `stored_name = randomUUID()`, store the original separately, resolve the final path with `path.resolve(root, bucket, storedName)`, and assert the result starts with the bucket directory. Reject any request whose bucket name isn't on the allowlist.

**Public vs private.** A bucket's visibility is a property decided at config/creation time, not per-file. The read middleware checks, in order: (1) is the bucket public? → serve; (2) is there a valid signed URL? → serve; (3) is there a valid auth token? → serve; (4) otherwise 401/403. Writes (upload/delete) always require auth regardless of bucket visibility.

**Signed URLs.** Signature = `HMAC-SHA256(secret, bucket + "/" + stored_name + "|" + expires)`. The verify middleware rejects if `now > expires` or the signature is constant-time-unequal. Rotating the storage secret invalidates all outstanding signed URLs — that's the revocation story. Signed URLs are the mechanism for serving private files to unauthenticated clients (e.g. an `<img>` in a public page).

**Upload limits.** Enforce `maxFileSize` before/during the stream; reject early. Reject `Content-Type` spoofing only as a hardening nicety — MIME is advisory, the extension is never used for the stored name anyway.

**Auth integration.** Reuse Phase 7's `requireAuth` middleware. Storage does not introduce a new auth system — a signed URL is an alternative credential for a single resource, not a user session.

---

## 🌐 REST API Surface (`/api/storage/*`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/storage/:bucket` | required | Upload file (multipart) → `{ path, storedName, originalName, size, mime }` |
| `GET` | `/api/storage/:bucket/:filename` | public bucket → none; private → auth **or** signed URL | Download/stream file |
| `DELETE` | `/api/storage/:bucket/:filename` | required | Delete file + metadata row |
| `GET` | `/api/storage/:bucket` | required | List files in bucket → `{ files: [...] }` |

Signed URL query params: `?expires=<unix-seconds>&sig=<hex-hmac>`. All responses follow the existing `{ data } | { error }` convention where applicable (streaming downloads return raw bytes + headers).

**Identifier safety rules (non-negotiable):**

- `:bucket` validated against `[a-z0-9-]{1,63}` before use.
- `:filename` is the **stored_name** (UUID), not the original. Looked up via `_files`; never interpolated into a path unchecked.
- Final disk path always re-checked to be inside `<root>/<bucket>/`.

---

## 🎛️ SDK Shape (`packages/sdk`)

```ts
const storage = db.storage; // new namespace

await storage.from("avatars").upload(file);
// → { path: "avatars/<uuid>.jpg", storedName: "<uuid>", originalName: "reyansh.jpg", size, mime }

const blob = await storage.from("avatars").download("reyansh.jpg");   // by original name
await storage.from("avatars").remove("reyansh.jpg");
const { files } = await storage.from("avatars").list();

const url      = storage.from("avatars").getPublicUrl("reyansh.jpg");          // public buckets
const signed   = await storage.from("documents").createSignedUrl("report.pdf", { expiresIn: 3600 });
```

**Note:** SDK methods address files by `original_name` for ergonomics; the SDK resolves to `stored_name` via a `_files` lookup. If original-name collisions become a problem, expose a `storedName`-keyed variant as a P1 follow-up.

---

## 📁 File Layout

```
.localbase/
  data.db
  storage/
    avatars/
      <uuid>.jpg
    documents/
      <uuid>.pdf
```

**`_files` table:**

```ts
_files: {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  bucket: { type: "text", nullable: false },
  stored_name: { type: "text", nullable: false },   // UUID on disk
  original_name: { type: "text", nullable: false }, // user-facing
  size: { type: "integer", nullable: false },
  mime: { type: "text" },
  uploaded_at: { type: "text", default: "CURRENT_TIMESTAMP" },
}
```

Index on `(bucket, original_name)` for SDK lookups, and `(bucket)` for listing.

---

## 🚀 Build Sequence (milestones)

Each milestone is independently shippable and verifiable.

### M1 — Storage engine + metadata (no API)
**Goal:** the engine that reads/writes files exists and is tested, with the `_files` table.

**Tasks:**
- [x] Add `buckets` to `LocalBaseConfig` — optional pre-declared list with `{ public }`; auto-create on first upload if not declared.
- [x] Create `_files` table (id, bucket, stored_name, original_name, size, mime, uploaded_at) + indexes.
- [x] Build storage engine: `save` (stream to disk, UUID name), `get` (stream), `delete`, `list`.
- [x] Enforce filename/path safety: UUID `stored_name`, reject path separators/null bytes, resolve-and-verify inside storage root, bucket-name allowlist.
- [x] Write engine tests: save/get/delete/list, path-traversal rejection (`..`, absolute, null bytes), bad bucket names.

**Done when:** engine round-trips a file, metadata matches disk, and every traversal vector is rejected.

### M2 — REST API (upload/download/delete/list) + multipart
**Goal:** HTTP endpoints work, streaming, with size limits.

**Tasks:**
- [x] Add `POST /api/storage/:bucket` endpoint — multipart parse via `c.req.parseBody`, stream to disk, enforce `maxFileSize`, insert `_files` row.
- [x] Add `GET /api/storage/:bucket/:filename` — resolve via `_files`, stream file, set `Content-Type` + `Content-Disposition: attachment; filename="<original>"`.
- [x] Add `DELETE /api/storage/:bucket/:filename` — delete file + metadata row (best-effort cleanup on partial failure).
- [x] Add `GET /api/storage/:bucket` — list files (paginated).
- [x] Write API tests: upload/download/list/delete, oversized upload rejected, original name preserved on download, `{ data } | { error }` shape.

**Done when:** a raw `curl` can upload, download (correct filename), list, and delete.

### M3 — Auth integration + public/private buckets + signed URLs
**Goal:** the security gate is real and tested.

**Tasks:**
- [x] Read gate: public bucket → open; private → `requireAuth` **or** valid signed URL; else 401/403.
- [x] Write gate: upload/delete always require `requireAuth` regardless of bucket visibility.
- [x] Implement signed URL generation: `HMAC-SHA256(secret, bucket/stored_name|expires)` → `?expires=&sig=`.
- [x] Implement signed URL verify middleware (constant-time compare, expiry check).
- [x] Wire storage secret config (fallback to JWT secret).
- [x] Write security tests: private bucket 401 without auth, 200 with auth, 200 with valid signed URL, expired/tampered signed URL rejected, public bucket open, writes always require auth.

**Done when:** the four read-gate branches and the always-auth write gate are all proven by tests.

### M4 — SDK namespace + Admin browser integration
**Goal:** developers use it from code; admins see it in the dashboard.

**Tasks:**
- [x] Add `storage` namespace to SDK: `upload`, `download`, `list`, `remove`, `getPublicUrl`, `createSignedUrl`.
- [x] SDK addresses files by `original_name` (resolves via `_files`).
- [x] Wire the Admin UI Storage browser (the P1 stub from `LOCALBASE-ADMIN-UI.md`) against `GET /api/storage/:bucket` + delete.
- [x] Write SDK integration tests: full upload→download→list→delete cycle, signed URL fetch from an unauthenticated client.
- [x] Update README with storage quickstart.

**Done when:** the SDK cycle works end-to-end and the Admin UI can browse + delete files.

---

## ⚠️ Risks & Open Questions

1. **Original-name collisions.** Two uploads with the same `original_name` in a bucket produce two rows; SDK `download(originalName)` becomes ambiguous. M4 resolves by `original_name`; if this bites, expose a `storedName`-keyed API as P1.
2. **Delete atomicity.** Disk delete + metadata delete can partially fail. M2 cleans up best-effort; a reconcile job is a later nicety.
3. **Streaming multipart.** Confirm Hono/Node streams the body to disk without buffering for large uploads within `maxFileSize`. Verify in M2.
4. **MIME trust.** Client-supplied `Content-Type` is advisory. Stored as-is in M1; do not ever use it to pick an executable extension (we don't — UUID names).
5. **Signed URL leakage.** A leaked signed URL is valid until expiry. Keep expirations short by default; document the tradeoff.
6. **No audit trail.** Upload/delete are high-impact. Not required for first cut; track alongside the Admin UI audit-log P1 follow-up.

---

## 🚫 Out of Scope (this plan)

- Object backends (S3 / R2 / B2) — local disk only for first cut.
- Per-user ownership / RLS (`owner_id` on `_files`) — P1 follow-up if private buckets need per-user isolation.
- Storage quotas (per-bucket / per-user size limits) — defer.
- Image transformations / thumbnails / on-the-fly resizing.
- CDN integration and custom cache headers.
- Bucket management UI (create/rename/delete buckets from the dashboard) — config/first-upload only for now.
- Resumable / chunked uploads.

---

## 🔗 Dependencies

- **Requires:** MVP (Database + API + SDK) ✅, Phase 7 Auth ✅ (for private buckets + signed-URL secret sharing).
- **Unblocks:** Admin UI Storage browser (P1 stub in `LOCALBASE-ADMIN-UI.md`).

---

## 📊 First-cut success metric

> A developer runs `await db.storage.from("avatars").upload(file)`, gets back a URL, serves a private file to an unauthenticated browser via a signed URL, and deletes it from the Admin UI — all without leaving LocalBase.
