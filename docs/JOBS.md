# Scheduled jobs

Declare cron work in `localbase.config.ts`. The same `localbase dev` / `studio` process runs enabled jobs, skips overlapping runs of the same job, and records every attempt in `_job_runs`.

Config: [CONFIG](./CONFIG.md#jobs).

---

## Handler

Default-export a function. It receives the live `Database` — this is trusted server code and **bypasses HTTP RLS**. Writes still emit realtime events.

```ts
import type { JobHandler } from "@localbase/core";

export default (async ({ db, log, name }) => {
  const deleted = db.delete("sessions", [
    { column: "expires_at", operator: "lt", value: new Date().toISOString() },
  ]);
  log(`${name}: deleted ${deleted} expired sessions`);
}) satisfies JobHandler;
```

- `db` — full `Database` instance
- `log(line)` — appended to the run’s `output`
- `name` — key from the `jobs` map
- A non-`undefined` return value is JSON-serialized into `output`
- A thrown error marks the run `failed` and stores the message in `error`

Output/error is truncated around **64 KiB**. Do not log secrets: admins can read `_job_runs` in Studio.

Handler modules are **cached**. Restart the process after editing a handler file. Config changes hot-reload and re-register jobs.

---

## Behavior

| Rule | Detail |
| --- | --- |
| Schedule | Standard 5-field cron (`m h dom mon dow`) |
| Timezone | IANA string, or server local |
| Missed runs | Not backfilled |
| Failures | Not retried automatically |
| Overlap | If the previous run is still active, the new firing is **skipped** (no row) |
| Disabled | `enabled: false` registers the job but does not schedule it |
| Multi-instance | No distributed lock — one process only |

---

## CLI and Studio

```bash
localbase jobs list
localbase jobs run cleanup_sessions
localbase jobs logs cleanup_sessions --limit 20
```

Studio **Jobs** view lists jobs, recent runs, and can trigger a run. Admin API: `GET /_api/admin/jobs`, `GET /_api/admin/jobs/:name/runs`, `POST /_api/admin/jobs/:name/run` (409 if already running).
