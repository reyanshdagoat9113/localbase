# Storage

Bucket-based files at `/api/storage/:bucket`, stored under `.localbase/storage/`. Each object is saved under a **server-generated UUID**; the original name is metadata and is restored on download via `Content-Disposition`. User filenames cannot traverse paths or overwrite another object.

Config: [CONFIG](./CONFIG.md#buckets-and-storage).

---

## Visibility

| | Public bucket | Private bucket |
| --- | --- | --- |
| Read | Open | Bearer **or** valid signed URL |
| Write / list / delete / sign | Always Bearer | Always Bearer |

If auth is disabled (no JWT secret): writes, listing, and private reads **fail closed**. Public-bucket reads still work. Signed URLs need a secret (`storage.secret` or `auth.jwtSecret`).

Default max upload: **50 MiB** (`storage.maxFileSize`). Oversize → 413.

Undeclared buckets are created **private** on first upload.

---

## SDK

Address files by **original name**. The client lists the bucket to resolve UUID `storedName`. Two uploads with the same original name can exist; resolution uses the first match.

```ts
await db.auth.signIn({ email, password });
const storage = db.storage.from("avatars");

const { data, error } = await storage.upload(file);
// Blob uploads: await storage.upload(blob, "photo.jpg");

await storage.list();
const { data: blob } = await storage.download("reyansh.jpg");
await storage.remove("reyansh.jpg");

const { data: url } = await storage.getPublicUrl("reyansh.jpg", { absolute: true });

const { data: signed } = await storage.createSignedUrl("report.pdf", {
  expiresIn: 3600,
});
```

`getPublicUrl` is for public buckets (no token). `createSignedUrl` is for private files (e.g. `<img src>` with no Authorization header). The signing secret never leaves the server.

---

## REST

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/storage/:bucket` | Bearer; multipart field `file` |
| `GET` | `/api/storage/:bucket` | Bearer (list) |
| `GET` | `/api/storage/:bucket/:storedName` | Public open; private Bearer or `?expires=&sig=` |
| `DELETE` | `/api/storage/:bucket/:storedName` | Bearer |
| `POST` | `/api/storage/:bucket/:storedName/sign` | Bearer; body `{ expiresIn? }` seconds |

REST paths use **stored** (UUID) names. Signed URLs carry `?expires=<unix>&sig=<hmac>` (constant-time verify, expiry checked). Rotating `storage.secret` revokes outstanding URLs.

Studio has a Storage browser for list/delete.

Backups copy the storage tree with the database: [BACKUP-AND-RECOVERY](./BACKUP-AND-RECOVERY.md).
