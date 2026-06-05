import { useEffect, useState, useCallback } from "react";
import {
  listBookmarks,
  createBookmark,
  updateBookmarkStatus,
  deleteBookmark,
  nextStatus,
  type Bookmark,
  type BookmarkStatus,
} from "./api";

type FilterStatus = BookmarkStatus | "all";

export default function App() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [search, setSearch] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listBookmarks({ status: filter, search: search.trim() || undefined });
      setBookmarks(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async (input: {
    url: string;
    title: string;
    description?: string;
    tags?: string;
  }) => {
    try {
      await createBookmark(input);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStatusCycle = async (id: number, current: BookmarkStatus) => {
    try {
      await updateBookmarkStatus(id, nextStatus(current));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this bookmark?")) return;
    try {
      await deleteBookmark(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>📖 Reading List</h1>
        <span className="server">localhost:54321</span>
      </header>

      {error && (
        <div className="error-banner">
          {error}
          <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {!showForm ? (
        <button className="btn btn-primary" onClick={() => setShowForm(true)} style={{ marginBottom: 16 }}>
          + Add bookmark
        </button>
      ) : (
        <BookmarkForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
      )}

      <div className="toolbar">
        <input
          className="search-input"
          placeholder="Search title, URL, description, tags…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="filter-group">
          {(["all", "unread", "reading", "read"] as FilterStatus[]).map((s) => (
            <button
              key={s}
              className={filter === s ? "active" : ""}
              onClick={() => setFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : bookmarks.length === 0 ? (
        <div className="empty-state">
          {search || filter !== "all"
            ? "No bookmarks match your filters."
            : "No bookmarks yet. Click \"Add bookmark\" to get started."}
        </div>
      ) : (
        bookmarks.map((b) => (
          <BookmarkCard
            key={b.id}
            bookmark={b}
            onStatusCycle={handleStatusCycle}
            onDelete={handleDelete}
          />
        ))
      )}
    </div>
  );
}

function BookmarkForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { url: string; title: string; description?: string; tags?: string }) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !title.trim()) return;
    onSubmit({
      url: url.trim(),
      title: title.trim(),
      description: description.trim() || undefined,
      tags: tags.trim() || undefined,
    });
  };

  return (
    <form className="card card-form" onSubmit={handleSubmit}>
      <label>
        URL
        <input
          required
          type="url"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
        />
      </label>
      <label>
        Title
        <input
          required
          type="text"
          placeholder="A short title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Description (optional)
        <textarea
          placeholder="Why is this worth reading?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Tags (optional, comma-separated)
        <input
          type="text"
          placeholder="react, performance, frontend"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          Save
        </button>
      </div>
    </form>
  );
}

function BookmarkCard({
  bookmark,
  onStatusCycle,
  onDelete,
}: {
  bookmark: Bookmark;
  onStatusCycle: (id: number, status: BookmarkStatus) => void;
  onDelete: (id: number) => void;
}) {
  const tags = bookmark.tags
    ? bookmark.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <div className="bookmark-card">
      <h3 className="title">
        <a href={bookmark.url} target="_blank" rel="noreferrer noopener">
          {bookmark.title}
        </a>
      </h3>
      <div className="url">{bookmark.url}</div>
      {bookmark.description && <p className="description">{bookmark.description}</p>}
      <div className="meta">
        <span className={`status-badge status-${bookmark.status}`}>{bookmark.status}</span>
        {tags.map((t) => (
          <span key={t} className="tag">
            #{t}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          {new Date(bookmark.created_at).toLocaleDateString()}
        </span>
      </div>
      <div className="actions">
        <button className="btn btn-small" onClick={() => onStatusCycle(bookmark.id, bookmark.status)}>
          → {nextStatus(bookmark.status)}
        </button>
        <button className="btn btn-small btn-danger" onClick={() => onDelete(bookmark.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}
