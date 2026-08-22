# 📋 Task Board — LocalBase Example

A Kanban-style task manager. 6 tables, foreign keys, many-to-many relationship, compound filtering.

**Stack:** Vite + React + TypeScript + LocalBase

---

## What this example demonstrates

This is a **complex** example that pushes LocalBase harder than the reading-list demo:

- **Authentication** — sign up / sign in with email + password, session persisted in localStorage, Bearer token auto-attached to all API calls
- **6 tables with foreign keys** — topological dependency order: `projects` → `columns`, `labels` → `tasks` → `task_labels`, `comments`
- **Many-to-many relationship** — tasks ↔ labels via a junction table (`task_labels`)
- **Compound filtering** — finds urgent tasks due in the next 7 days using chained `.in()` + `.gte()` + `.lte()`
- **Multiple sort keys** — tasks sorted by `position`, projects by `created_at`
- **Cascade deletes** — deleting a project removes columns/tasks/comments/labels in the right order
- **Hydration pattern** — `hydrateTasks()` shows how to do "manual JOINs" across 3 tables in a single pass
- **Date comparisons** — overdue detection, upcoming deadlines
- **Bulk fetches** — `.in("task_id", [...])` to fetch comments for many tasks at once

---

## Schema

```
projects
  ├── columns        (FK: project_id)
  │     └── tasks    (FK: column_id, project_id)
  │           ├── task_labels  (junction: task_id, label_id)
  │           └── comments     (FK: task_id)
  └── labels         (FK: project_id)
```

See `localbase.config.ts` for the full schema definition.

---

## Run it

You need two terminals.

### Terminal 1 — start LocalBase

```bash
cd examples/task-board
npx @localbase/cli dev
# or, with @localbase/cli installed: localbase dev
```

Server runs at `http://localhost:5180`.

### Terminal 2 — start the frontend

From the repo root, install once:

```bash
npm install
```

Then:

```bash
cd examples/task-board
npm run dev
```

Open the URL Vite prints (http://localhost:3001).

---

## How to use

### 1. Sign up or sign in
When you first open the app, you'll see a login screen. Create an account or sign in — your session persists across page reloads.

### 2. Create a project
Click **+ New Project**. Pick a name and color.

### 2. Add columns (kanban stages)
Inside the project, click **+ Column**. Add e.g. "Backlog", "In Progress", "Done".

### 3. Add labels
Click **+ Label**. Add e.g. "bug" (red), "feature" (green), "docs" (blue).

### 4. Add tasks
Inside any column, click **+ Add task**. Set a title and priority.

### 5. Move tasks between columns
Each task card has buttons to move it to any other column.

### 6. Open a task
Click any task card to open the detail view. Edit title, description, priority, due date, labels. Add comments — they're automatically attributed to your signed-in email.

### 7. Watch the "urgent tasks" banner
Tasks with priority `high` or `urgent` AND a `due_date` in the next 7 days trigger a yellow banner at the top of the board.

---

## Try the raw API

Open these in your browser or curl:

```bash
# All projects
curl http://localhost:5180/api/projects

# Tasks in a specific project
curl http://localhost:5180/api/tasks?project_id=eq.1

# High-priority tasks
curl http://localhost:5180/api/tasks?priority=eq.high

# Urgent AND has a due date (compound filter)
curl "http://localhost:5180/api/tasks?priority=in.high,urgent&due_date=gte.2026-01-01"

# Tasks sorted by priority then position
curl "http://localhost:5180/api/tasks?order=priority.desc,position.asc&limit=20"

# Insert a task
curl -X POST http://localhost:5180/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"project_id":1,"column_id":1,"title":"Test","priority":"high"}'
```

---

## File structure

```
examples/task-board/
├── localbase.config.ts     ← 6-table schema with FKs
├── package.json
├── vite.config.ts
├── index.html
├── tsconfig.json
├── README.md
└── src/
    ├── main.tsx
    ├── App.tsx              ← all UI: projects list, board, task detail
    ├── api.ts               ← LocalBase SDK wrapper (every CRUD pattern)
    ├── types.ts             ← shared types
    └── styles.css
```

---

## SDK patterns used (see `api.ts`)

| Pattern | Where | What it shows |
|---|---|---|
| Auth (sign up) | `AuthScreen` | `db.auth.signUp({ email, password })` |
| Auth (sign in) | `AuthScreen` | `db.auth.signIn({ email, password })` |
| Session persist | `api.ts` | `db.auth.setSession` + `localStorage` |
| Auto Bearer token | `api.ts` | Token attached to every `db.from()` call after login |
| Single-row insert | `createProject` | Plain `.insert({...})` |
| Filtered list | `listColumns` | `.eq("project_id", id).order("position")` |
| Get single | `getProject` | `.eq("id", id).single()` |
| IN filter | `listUpcomingUrgentTasks` | `.in("priority", ["high", "urgent"])` |
| Range filter | `listUpcomingUrgentTasks` | `.gte(...).lte(...)` chained |
| Update by id | `updateTask` | `.update({...}).eq("id", id)` |
| Manual cascade | `deleteProject` | Delete children before parent |
| Hydration (N+1 fix) | `hydrateTasks` | One bulk fetch, join in JS |
| Junction table | `setTaskLabels` | Delete all + re-insert pattern |
| Bulk IN | `hydrateTasks` | `.in("task_id", [list])` |

---

## What this example reveals

Real-world patterns that come up:

1. **Manual JOINs are needed** — LocalBase has no relational selects (yet). `hydrateTasks` shows the right pattern: fetch tasks, fetch all related rows in 2 queries, join in JS.

2. **Cascading deletes are manual** — Foreign keys prevent deletion of parents with children, but you have to delete the children yourself. See `deleteProject`.

3. **Junction tables work fine** — Many-to-many is just a regular table with two FKs. `setTaskLabels` shows the "delete-then-insert" replacement pattern.

4. **Compound filters compose** — Multiple `.eq()`, `.in()`, `.gte()` on different columns all AND together naturally.

5. **Order matters in cascade deletes** — projects → columns/labels → tasks → task_labels/comments. SDK doesn't auto-cascade.

---

## Troubleshooting

**"No localbase.config.ts found"** — run the CLI from this folder (`npx @localbase/cli dev`).

**"Failed to fetch"** — make sure `localbase dev` is running on port 5180.

**"Email already registered"** — that account exists. Click "Sign in" on the login screen instead.

**"Invalid email or password"** — wrong password, or no account with that email. Try signing up first.

**"FOREIGN KEY constraint failed"** — you're trying to delete a parent with children. See `deleteProject` for the correct order.

**Port 5180 already in use** — `npx @localbase/cli dev --port 5181`, then update `src/api.ts`.

**Reset everything** — `npx @localbase/cli db reset` while the dev server is stopped.
