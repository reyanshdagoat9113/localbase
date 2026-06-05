import { createClient } from "@localbase/sdk";

export type BookmarkStatus = "unread" | "reading" | "read";

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  description: string | null;
  status: BookmarkStatus;
  tags: string | null;
  created_at: string;
}

const baseUrl = "http://localhost:5180";
export const db = createClient(baseUrl);

export async function listBookmarks(opts: {
  status?: BookmarkStatus | "all";
  search?: string;
}): Promise<Bookmark[]> {
  let q = db.from<Bookmark[]>("bookmarks").select("*").order("created_at", { ascending: false });

  if (opts.status && opts.status !== "all") {
    q = q.eq("status", opts.status);
  }

  const { data, error } = await q;
  if (error) throw new Error(error);

  let rows = data ?? [];
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    rows = rows.filter(
      (b) =>
        b.title.toLowerCase().includes(needle) ||
        b.url.toLowerCase().includes(needle) ||
        (b.description ?? "").toLowerCase().includes(needle) ||
        (b.tags ?? "").toLowerCase().includes(needle)
    );
  }
  return rows;
}

export async function createBookmark(input: {
  url: string;
  title: string;
  description?: string;
  tags?: string;
}): Promise<Bookmark> {
  const { data, error } = await db
    .from<Bookmark>("bookmarks")
    .insert({
      url: input.url,
      title: input.title,
      description: input.description ?? null,
      tags: input.tags ?? null,
    });
  if (error) throw new Error(error);
  return data as Bookmark;
}

export async function updateBookmarkStatus(
  id: number,
  status: BookmarkStatus
): Promise<Bookmark> {
  const { data, error } = await db
    .from<Bookmark>("bookmarks")
    .update({ status })
    .eq("id", id);
  if (error) throw new Error(error);
  return data as Bookmark;
}

export async function deleteBookmark(id: number): Promise<void> {
  const { error } = await db.from("bookmarks").delete().eq("id", id);
  if (error) throw new Error(error);
}

export function nextStatus(s: BookmarkStatus): BookmarkStatus {
  if (s === "unread") return "reading";
  if (s === "reading") return "read";
  return "unread";
}
