import { createClient } from "@localbase/sdk";
import type {
  Column,
  Comment,
  Label,
  Priority,
  Project,
  Task,
  TaskLabel,
  TaskWithMeta,
} from "./types";

const baseUrl = "http://localhost:5180";
export const db = createClient(baseUrl);

// ──────────────────────────────────────────────────────────────
// Session persistence
// ──────────────────────────────────────────────────────────────

const SESSION_KEY = "taskboard-session";

/** Restore a previously saved session (e.g. on page load). */
export function restoreSession(): void {
  const raw = localStorage.getItem(SESSION_KEY);
  if (raw) {
    try {
      db.auth.setSession(JSON.parse(raw));
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
  }
}

/** Save the current session to localStorage. */
export function saveSession(): void {
  const session = db.auth.getSession();
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

/** Clear the persisted session. */
export function clearPersistedSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

/** Check if the client has an active session. */
export function isAuthenticated(): boolean {
  return db.auth.getSession() !== null;
}

/** Get the current user's email, or null if not signed in. */
export function currentUserEmail(): string | null {
  return db.auth.getSession()?.user.email ?? null;
}

// ──────────────────────────────────────────────────────────────
// Projects
// ──────────────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await db
    .from<Project[]>("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error);
  return data ?? [];
}

export async function getProject(id: number): Promise<Project | null> {
  const { data, error } = await db.from<Project>("projects").select("*").eq("id", id).single();
  if (error) throw new Error(error);
  return data;
}

export async function createProject(input: {
  name: string;
  description?: string;
  color?: string;
}): Promise<Project> {
  const { data, error } = await db.from<Project>("projects").insert({
    name: input.name,
    description: input.description ?? null,
    color: input.color ?? "#3b82f6",
  });
  if (error) throw new Error(error);
  return data as Project;
}

export async function deleteProject(id: number): Promise<void> {
  // Manual cascade — delete children first, then the project
  // NOTE: This will fail if we delete the project directly due to FK constraints
  const cols = await listColumns(id);
  for (const c of cols) {
    await deleteTasksByColumn(c.id);
  }
  await db.from("columns").delete().eq("project_id", id);
  await db.from("labels").delete().eq("project_id", id);
  const { error } = await db.from("projects").delete().eq("id", id);
  if (error) throw new Error(error);
}

// ──────────────────────────────────────────────────────────────
// Columns
// ──────────────────────────────────────────────────────────────

export async function listColumns(projectId: number): Promise<Column[]> {
  const { data, error } = await db
    .from<Column[]>("columns")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  if (error) throw new Error(error);
  return data ?? [];
}

export async function createColumn(input: {
  project_id: number;
  name: string;
  position: number;
}): Promise<Column> {
  const { data, error } = await db.from<Column>("columns").insert(input);
  if (error) throw new Error(error);
  return data as Column;
}

export async function renameColumn(id: number, name: string): Promise<void> {
  const { error } = await db.from("columns").update({ name }).eq("id", id);
  if (error) throw new Error(error);
}

export async function deleteColumn(id: number): Promise<void> {
  await deleteTasksByColumn(id);
  const { error } = await db.from("columns").delete().eq("id", id);
  if (error) throw new Error(error);
}

// ──────────────────────────────────────────────────────────────
// Labels
// ──────────────────────────────────────────────────────────────

export async function listLabels(projectId: number): Promise<Label[]> {
  const { data, error } = await db
    .from<Label[]>("labels")
    .select("*")
    .eq("project_id", projectId)
    .order("name", { ascending: true });
  if (error) throw new Error(error);
  return data ?? [];
}

export async function createLabel(input: {
  project_id: number;
  name: string;
  color: string;
}): Promise<Label> {
  const { data, error } = await db.from<Label>("labels").insert(input);
  if (error) throw new Error(error);
  return data as Label;
}

// ──────────────────────────────────────────────────────────────
// Tasks
// ──────────────────────────────────────────────────────────────

export async function listTasks(projectId: number): Promise<Task[]> {
  const { data, error } = await db
    .from<Task[]>("tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("position", { ascending: true });
  if (error) throw new Error(error);
  return data ?? [];
}

export async function listTasksByColumn(columnId: number): Promise<Task[]> {
  const { data, error } = await db
    .from<Task[]>("tasks")
    .select("*")
    .eq("column_id", columnId)
    .order("position", { ascending: true });
  if (error) throw new Error(error);
  return data ?? [];
}

/**
 * Compound filter example: high-priority tasks due in the next 7 days.
 */
export async function listUpcomingUrgentTasks(projectId: number): Promise<Task[]> {
  const now = new Date().toISOString();
  const week = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from<Task[]>("tasks")
    .select("*")
    .eq("project_id", projectId)
    .in("priority", ["high", "urgent"])
    .gte("due_date", now)
    .lte("due_date", week);
  if (error) throw new Error(error);
  return data ?? [];
}

export async function createTask(input: {
  project_id: number;
  column_id: number;
  title: string;
  description?: string;
  priority?: Priority;
  due_date?: string | null;
  position?: number;
}): Promise<Task> {
  const { data, error } = await db.from<Task>("tasks").insert({
    project_id: input.project_id,
    column_id: input.column_id,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? "medium",
    due_date: input.due_date ?? null,
    position: input.position ?? 0,
  });
  if (error) throw new Error(error);
  return data as Task;
}

export async function updateTask(
  id: number,
  patch: Partial<Pick<Task, "title" | "description" | "priority" | "due_date" | "column_id" | "position">>
): Promise<Task> {
  const { data, error } = await db.from<Task>("tasks").update(patch).eq("id", id);
  if (error) throw new Error(error);
  return data as Task;
}

export async function deleteTask(id: number): Promise<void> {
  // Manual cascade: delete comments + label associations first
  await db.from("comments").delete().eq("task_id", id);
  await db.from("task_labels").delete().eq("task_id", id);
  const { error } = await db.from("tasks").delete().eq("id", id);
  if (error) throw new Error(error);
}

export async function deleteTasksByColumn(columnId: number): Promise<void> {
  const tasks = await listTasksByColumn(columnId);
  for (const t of tasks) {
    await deleteTask(t.id);
  }
}

/**
 * Hydrate tasks with their labels and comment counts.
 * Demonstrates the "manual JOIN" pattern: 1 + N queries.
 * For small datasets this is fine; for larger ones, consider denormalizing.
 */
export async function hydrateTasks(tasks: Task[]): Promise<TaskWithMeta[]> {
  if (tasks.length === 0) return [];

  // Get all task-label associations for these tasks
  const taskIds = tasks.map((t) => t.id);
  const { data: linksData, error: linksErr } = await db
    .from<TaskLabel[]>("task_labels")
    .select("*")
    .in("task_id", taskIds);
  if (linksErr) throw new Error(linksErr);

  // Get all labels referenced (unique)
  const labelIds = Array.from(new Set((linksData ?? []).map((l) => l.label_id)));
  let labels: Label[] = [];
  if (labelIds.length > 0) {
    // Fetch each label by id. (SDK has no OR/IN for labels here yet — we'll fetch all and filter.)
    // NOTE: This uses SDK .in() which works.
    const { data: labelData, error: labelErr } = await db
      .from<Label[]>("labels")
      .select("*")
      .in("id", labelIds);
    if (labelErr) throw new Error(labelErr);
    labels = labelData ?? [];
  }

  // Get comment counts per task (single query, group in JS)
  const { data: commentsData, error: commentsErr } = await db
    .from<Comment[]>("comments")
    .select("*")
    .in("task_id", taskIds);
  if (commentsErr) throw new Error(commentsErr);

  const commentCounts = new Map<number, number>();
  for (const c of commentsData ?? []) {
    commentCounts.set(c.task_id, (commentCounts.get(c.task_id) ?? 0) + 1);
  }

  // Group label associations by task
  const labelsByTask = new Map<number, Label[]>();
  for (const link of linksData ?? []) {
    const label = labels.find((l) => l.id === link.label_id);
    if (!label) continue;
    if (!labelsByTask.has(link.task_id)) labelsByTask.set(link.task_id, []);
    labelsByTask.get(link.task_id)!.push(label);
  }

  return tasks.map((t) => ({
    ...t,
    labels: labelsByTask.get(t.id) ?? [],
    comment_count: commentCounts.get(t.id) ?? 0,
  }));
}

// ──────────────────────────────────────────────────────────────
// Task ↔ Labels (many-to-many)
// ──────────────────────────────────────────────────────────────

export async function setTaskLabels(taskId: number, labelIds: number[]): Promise<void> {
  // Replace strategy: delete all existing, insert new
  const { error: delErr } = await db.from("task_labels").delete().eq("task_id", taskId);
  if (delErr) throw new Error(delErr);

  for (const labelId of labelIds) {
    const { error } = await db.from("task_labels").insert({ task_id: taskId, label_id: labelId });
    if (error) throw new Error(error);
  }
}

// ──────────────────────────────────────────────────────────────
// Comments
// ──────────────────────────────────────────────────────────────

export async function listComments(taskId: number): Promise<Comment[]> {
  const { data, error } = await db
    .from<Comment[]>("comments")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error);
  return data ?? [];
}

export async function createComment(input: {
  task_id: number;
  author: string;
  body: string;
}): Promise<Comment> {
  // If the user is signed in, always use their email as the author.
  // Fall back to the provided author for anonymous / legacy data.
  const author = currentUserEmail() ?? input.author;
  const { data, error } = await db.from<Comment>("comments").insert({
    ...input,
    author,
  });
  if (error) throw new Error(error);
  return data as Comment;
}

export async function deleteComment(id: number): Promise<void> {
  const { error } = await db.from("comments").delete().eq("id", id);
  if (error) throw new Error(error);
}
