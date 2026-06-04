# 🚀 LocalBase Post-MVP

> What we build after the MVP ships. Focused on what makes the platform feel modern.

---

## Priority Order

1. **Realtime** — biggest perceived value, hardest to do well
2. **Scheduled Jobs** — genuinely useful, simpler scope
3. **Storage** — niche but easy to add

Edge Functions are **out of scope**. Developers can just write Node scripts.

---

### Phase 7: Realtime

**Goal:** Frontend gets notified instantly when data changes — no polling.

**SDK example:**

```ts
db.subscribe("messages", (event) => {
  console.log(event);
  // { type: "insert", table: "messages", row: { id: 5, text: "Hi" } }
});

db.subscribe("messages", { where: { room_id: 1 } }, (event) => {
  // Only fires for messages in this room
});
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Event emitter | `packages/core` | Hooks into insert/update/delete, emits events |
| Subscription manager | `packages/core` | Tracks who's subscribed to what |
| WebSocket server | `packages/core` | Handles WS connections, broadcasts events |
| SDK subscribe | `packages/sdk` | Opens WS, parses events |
| CLI | `packages/cli` | No changes — WS runs inside `dev` |

**Tasks:**

- [ ] Add `EventEmitter` to `Database` class
- [ ] Emit `insert`/`update`/`delete` events from `query.ts` (include row data)
- [ ] Create `SubscriptionManager` — tracks subscriptions by table + filter
- [ ] Set up WebSocket server alongside Hono (use `ws` or `@hono/node-server` WS helper)
- [ ] Implement subscription message protocol: `{ subscribe: "messages", filter: {...} }`
- [ ] Send events to subscribed clients with row payload
- [ ] Handle reconnect + missed events (event log buffer)
- [ ] Add `db.subscribe(table, filter?, callback)` to SDK
- [ ] Add subscription filters (where, equals, gt, etc.)
- [ ] Add presence support (optional, later)
- [ ] Write integration tests: emit on insert, verify WS receives

---

### Phase 8: Scheduled Jobs

**Goal:** Define cron jobs in config, LocalBase runs them automatically.

**Config example:**

```ts
export default {
  tables: { ... },
  jobs: {
    cleanup_sessions: {
      schedule: "0 3 * * *",        // 3 AM daily
      handler: "./jobs/cleanup.ts", // path to job file
    },
    weekly_report: {
      schedule: "0 9 * * 1",        // 9 AM every Monday
      handler: "./jobs/report.ts",
    },
  },
};
```

**CLI:**

```
localbase jobs list              Show all registered jobs + next run time
localbase jobs run <name>        Manually trigger a job
localbase jobs logs <name>       Show run history for a job
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Job registry | `packages/core` | Loads jobs from config, validates schedule |
| Scheduler | `packages/core` | Runs jobs on cron schedule |
| Job runner | `packages/core` | Loads handler file, executes, captures output |
| Logs table | SQLite | Tracks run history |
| CLI commands | `packages/cli` | List, run, logs |

**Tasks:**

- [ ] Define `JobConfig` type in `shared` (name, schedule, handler path)
- [ ] Add `jobs` property to `LocalBaseConfig` type
- [ ] Create `_job_runs` table (id, job_name, started_at, ended_at, status, output, error)
- [ ] Pick cron parser library (`node-cron` or `croner`)
- [ ] Build scheduler that wakes up on next-job-due
- [ ] Build job runner: import handler module via jiti, call with `{ db }` context
- [ ] Wrap each run in try/catch, log to `_job_runs`
- [ ] Integrate scheduler into `dev` command (start with server)
- [ ] Implement `localbase jobs list` (name, schedule, next run, last run)
- [ ] Implement `localbase jobs run <name>` (manual trigger)
- [ ] Implement `localbase jobs logs <name>` (last N runs)
- [ ] Write tests: schedule, run, log

---

### Phase 9: Storage

**Goal:** File uploads/downloads with bucket abstraction.

**SDK example:**

```ts
await storage.from("avatars").upload(file);
// → { path: "avatars/reyansh.jpg", url: "http://localhost:54321/storage/avatars/reyansh.jpg" }

const url = storage.from("avatars").getPublicUrl("reyansh.jpg");
const signedUrl = await storage.from("documents").createSignedUrl("report.pdf", { expiresIn: 3600 });
```

**REST API:**

```
POST   /api/storage/:bucket              Upload file (multipart)
GET    /api/storage/:bucket/:filename    Download file
DELETE /api/storage/:bucket/:filename    Delete file
GET    /api/storage/:bucket              List files in bucket
```

**File layout:**

```
.localbase/
  data.db
  storage/
    avatars/
      reyansh.jpg
    documents/
      report.pdf
```

**Implementation:**

| Component | Where | What it does |
|---|---|---|
| Storage engine | `packages/core` | Read/write files to `.localbase/storage/` |
| Upload endpoint | `packages/core` | Multipart parser, writes file |
| Download endpoint | `packages/core` | Streams file from disk |
| Metadata table | SQLite | Tracks file metadata (size, mime, uploaded_at) |
| Signed URLs | `packages/core` | HMAC-signed expiring URLs |
| SDK | `packages/sdk` | `storage.from(bucket).upload/get/list` |

**Tasks:**

- [ ] Add `buckets` to `LocalBaseConfig` (define buckets in config, or auto-create)
- [ ] Create `_files` table (id, bucket, filename, size, mime, uploaded_at)
- [ ] Build storage engine: save file, get file, delete file, list bucket
- [ ] Add `POST /api/storage/:bucket` endpoint with multipart parsing
- [ ] Add `GET /api/storage/:bucket/:filename` endpoint (stream file)
- [ ] Add `DELETE /api/storage/:bucket/:filename` endpoint
- [ ] Add `GET /api/storage/:bucket` endpoint (list files)
- [ ] Implement signed URL generation (HMAC + expiry timestamp)
- [ ] Implement signed URL verification middleware
- [ ] Add `storage` namespace to SDK
- [ ] Write integration tests: upload, download, list, delete, signed URL

---

## Decision Points (Defer Until Needed)

- **Auth for storage** — without auth, all files are public. Defer until auth exists.
- **Realtime row-level security** — without auth, all events go to all subscribers. Defer until auth exists.
- **Job retries** — if a job fails, should it retry? Defer; just log for now.
- **Storage quotas** — limit per-bucket size? Defer.
- **WebSocket scale** — single-process only for now. If we ever need multi-process, switch to Redis pubsub.

---

## Prerequisites

- Phase 7 requires MVP complete (Database + API + SDK foundation)
- Phase 8 requires MVP complete
- Phase 9 is independent, can ship anytime

Phases 7, 8, 9 are independent — build in any order based on demand.
