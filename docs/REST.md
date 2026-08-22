# REST API

Generated from `tables` in `localbase.config.ts`. Base URL defaults to `http://127.0.0.1:5180`.

Envelope:

```json
{ "data": {}, "error": null }
```

Errors use `{ "error": "message" }` (no `data`). Auth routes use the same envelope.

There are **no SQL joins**. Fetch related tables separately. Column lists on `GET` are not a projection — rows return every column.

---

## Table CRUD

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/:table` | List rows |
| `POST` | `/api/:table` | Insert one row |
| `GET` | `/api/:table/:id` | Get one row by primary key |
| `PATCH` | `/api/:table/:id` | Partial update |
| `DELETE` | `/api/:table/:id` | Delete |

Unknown table → 404. Unknown column in body or filter → 400. UNIQUE / FK violations → 409.

### Query parameters (`GET /api/:table`)

```
GET /api/users?age=gte.25&order=created_at.desc,name.asc&limit=10&offset=20
```

| Param | Format | Example |
| --- | --- | --- |
| Filter | `?col=op.value` | `?age=gte.25` |
| Sort | `?order=col.dir[,col.dir]` | `?order=created_at.desc` |
| Limit | `?limit=N` | `?limit=10` |
| Offset | `?offset=N` | `?offset=20` |

**Operators:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `like`, `in`

- Filters AND together.
- `in` is comma-separated: `?name=in.Alice,Bob`
- `like` is SQLite `LIKE` (supply `%` / `_` yourself): `?title=like.%draft%`
- Booleans in filters are numeric: `?published=eq.1`

### Insert / update body

JSON object of column names. Required columns (`nullable: false`, no `default`, not autoincrement PK) must be present on insert. Extra keys → 400.

---

## Other HTTP APIs

Documented with their features:

- Auth — [AUTH](./AUTH.md)
- Storage — [STORAGE](./STORAGE.md)
- Admin JSON (`/_api/admin/*`) — [ADMIN](./ADMIN.md)
- Realtime is WebSocket, not REST — [REALTIME](./REALTIME.md)

---

## Status codes

| Code | When |
| --- | --- |
| `200` | Success |
| `201` | Created (insert, sign-up, owner bootstrap) |
| `202` | Accepted (admin-account request) |
| `400` | Validation / bad filter |
| `401` | Missing or invalid auth (or RLS table without a session) |
| `403` | Authenticated but not allowed (admin routes, owner-only actions) |
| `404` | Unknown table or row. RLS hides other users’ rows as 404, not 403 |
| `409` | UNIQUE / FK / last-admin / duplicate email |
| `413` | JSON body or upload too large |
| `429` | Rate limit (abuse-sensitive routes; `Retry-After` set) |
| `500` | Unexpected server error |

Default JSON body cap is ~1 MiB (`security.bodyLimitBytes`). Storage uploads use `storage.maxFileSize` instead.
