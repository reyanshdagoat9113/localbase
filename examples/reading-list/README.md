# 📖 Reading List — LocalBase Example

A small web app demonstrating LocalBase in a real frontend. Define bookmarks, filter by status, search, mark as read.

**Stack:** Vite + React + TypeScript + LocalBase

---

## What it demonstrates

- Define a schema in `localbase.config.ts`
- Run LocalBase dev server (`localbase dev`)
- Talk to it from a React frontend via `@localbase/sdk`
- Full CRUD: insert / update / delete / filter / search
- Live updates — refresh button pulls fresh data

---

## Schema

```ts
export default {
  tables: {
    bookmarks: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      url: { type: "text", nullable: false },
      title: { type: "text", nullable: false },
      description: { type: "text" },
      status: { type: "text", default: "'unread'" },
      tags: { type: "text" },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
  },
};
```

---

## Run it

You need two terminals.

### Terminal 1 — start LocalBase

From this folder (`examples/reading-list/`):

```bash
localbase dev
```

You should see:

```
✔ Server running at http://localhost:54321
ℹ Watching localbase.config.ts for changes...
```

### Terminal 2 — start the frontend

From the repo root, install once:

```bash
npm install
```

Then from this folder:

```bash
npm run dev
```

Open the URL Vite prints (http://localhost:5180).

---

## How to use

1. Click **+ Add bookmark**
2. Paste a URL, give it a title, optional description and tags
3. Use the filter bar to filter by status (all / unread / reading / read)
4. Use the search box to filter by title, URL, description, or tags
5. Click **→ reading** / **→ read** / **→ unread** to cycle status
6. Click **Delete** to remove

---

## Try the raw API

While the dev server is running, open these in your browser:

```
http://localhost:54321/api/bookmarks
http://localhost:54321/api/bookmarks?status=eq.unread&order=created_at.desc&limit=5
```

Or with curl:

```bash
# Add a bookmark
curl -X POST http://localhost:54321/api/bookmarks \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","title":"Example"}'

# List unread
curl http://localhost:54321/api/bookmarks?status=eq.unread
```

---

## File structure

```
examples/reading-list/
├── localbase.config.ts    ← schema definition
├── package.json
├── vite.config.ts
├── index.html
├── tsconfig.json
└── src/
    ├── main.tsx
    ├── App.tsx            ← all UI logic
    ├── api.ts             ← LocalBase SDK wrapper
    └── styles.css
```

---

## What you should observe

- The dev server hot-reloads when you edit `localbase.config.ts` (try changing the `status` default from `'unread'` to `'reading'`)
- The SQLite database lives in `.localbase/data.db` — open it with any SQLite viewer to inspect the raw data
- All SDK calls return `{ data, error }` — see `api.ts` for the pattern
- Restart the server and your data persists

---

## Troubleshooting

**"No localbase.config.ts found"** — make sure you run `localbase dev` from this folder.

**CORS errors in the browser console** — not an issue, LocalBase's dev server allows all origins. If you see them, check the URL is `http://localhost:54321`.

**"Cannot find @localbase/sdk"** — run `npm install` from the repo root.

**Port 54321 already in use** — `localbase dev --port 54322`, then update `src/api.ts`.
