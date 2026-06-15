import { useCallback, useEffect, useState } from "react";
import type { Column, Comment, Label, Priority, Project, Task, TaskWithMeta } from "./types";
import {
  clearPersistedSession,
  createColumn,
  createComment,
  createLabel,
  createProject,
  createTask,
  db,
  deleteColumn,
  deleteComment,
  deleteProject,
  deleteTask,
  getProject,
  hydrateTasks,
  isAuthenticated,
  listColumns,
  listComments,
  listLabels,
  listProjects,
  listTasks,
  listUpcomingUrgentTasks,
  restoreSession,
  saveSession,
  setTaskLabels as saveTaskLabels,
  updateTask,
} from "./api";

type View =
  | { kind: "auth" }
  | { kind: "projects" }
  | { kind: "board"; projectId: number }
  | { kind: "task"; projectId: number; taskId: number };

export default function App() {
  const [view, setView] = useState<View>({ kind: "auth" });
  const [error, setError] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);

  // Restore persisted session on mount
  useEffect(() => {
    restoreSession();
    if (isAuthenticated()) {
      setAuthed(true);
      setView({ kind: "projects" });
    }
  }, []);

  const report = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const handleAuthSuccess = useCallback(() => {
    saveSession();
    setAuthed(true);
    setView({ kind: "projects" });
  }, []);

  const handleSignOut = useCallback(async () => {
    await db.auth.signOut();
    clearPersistedSession();
    setAuthed(false);
    setView({ kind: "auth" });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>📋 Task Board</h1>
        {authed ? (
          <div className="header-user">
            <span className="user-email">{db.auth.getSession()?.user.email}</span>
            <button className="btn btn-small" onClick={handleSignOut}>Sign out</button>
          </div>
        ) : (
          <span className="server">localhost:5180</span>
        )}
      </header>

      {error && (
        <div className="error-banner">
          {error}
          <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {view.kind === "auth" && (
        <AuthScreen onSuccess={handleAuthSuccess} onError={report} />
      )}

      {view.kind === "projects" && (
        <ProjectsView onError={report} onOpen={(id) => setView({ kind: "board", projectId: id })} />
      )}

      {view.kind === "board" && (
        <BoardView
          projectId={view.projectId}
          onError={report}
          onBack={() => setView({ kind: "projects" })}
          onOpenTask={(taskId) => setView({ kind: "task", projectId: view.projectId, taskId })}
        />
      )}

      {view.kind === "task" && (
        <TaskDetailView
          projectId={view.projectId}
          taskId={view.taskId}
          onError={report}
          onBack={() => setView({ kind: "board", projectId: view.projectId })}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Auth screen (sign up / sign in)
// ──────────────────────────────────────────────────────────────

function AuthScreen({
  onSuccess,
  onError,
}: {
  onSuccess: () => void;
  onError: (e: unknown) => void;
}) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setLoading(true);
    setAuthError(null);

    try {
      const result = isSignUp
        ? await db.auth.signUp({ email: email.trim(), password })
        : await db.auth.signIn({ email: email.trim(), password });

      if (result.error) {
        setAuthError(result.error);
      } else {
        onSuccess();
      }
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h2>{isSignUp ? "Create an account" : "Welcome back"}</h2>
        <p className="auth-subtitle">
          {isSignUp
            ? "Sign up to start managing your projects."
            : "Sign in to your task board."}
        </p>

        {authError && (
          <div className="error-banner">{authError}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label>Email</label>
            <input
              type="email"
              autoFocus
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input
              type="password"
              required
              placeholder={isSignUp ? "At least 6 characters" : "Your password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary auth-submit"
            disabled={loading}
          >
            {loading ? "…" : isSignUp ? "Sign Up" : "Sign In"}
          </button>
        </form>

        <p className="auth-toggle">
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            className="btn-link"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setAuthError(null);
            }}
          >
            {isSignUp ? "Sign in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Projects list view
// ──────────────────────────────────────────────────────────────

function ProjectsView({
  onError,
  onOpen,
}: {
  onError: (e: unknown) => void;
  onOpen: (id: number) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listProjects());
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
    // Realtime: refresh the project list whenever projects change.
    return db.subscribe("projects", () => refresh());
  }, [refresh]);

  const handleCreate = async (input: { name: string; description?: string; color?: string }) => {
    try {
      await createProject(input);
      setShowForm(false);
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this project and all its tasks?")) return;
    try {
      await deleteProject(id);
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          + New Project
        </button>
      </div>

      {showForm && (
        <ProjectForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
      )}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects yet. Click "New Project" to start.</div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <div
              key={p.id}
              className="project-card"
              style={{ borderLeftColor: p.color }}
              onClick={() => onOpen(p.id)}
            >
              <h3>{p.name}</h3>
              {p.description && <p className="desc">{p.description}</p>}
              <div className="meta">
                <span>Created {new Date(p.created_at).toLocaleDateString()}</span>
                <button
                  className="del-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p.id);
                  }}
                  title="Delete project"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ProjectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { name: string; description?: string; color?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#3b82f6");

  return (
    <form
      className="modal"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit({ name: name.trim(), description: description.trim() || undefined, color });
      }}
    >
      <h2>New Project</h2>
      <div className="form-field">
        <label>Name</label>
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-field">
        <label>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="form-field">
        <label>Color</label>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary">Create</button>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────
// Board view (kanban)
// ──────────────────────────────────────────────────────────────

function BoardView({
  projectId,
  onError,
  onBack,
  onOpenTask,
}: {
  projectId: number;
  onError: (e: unknown) => void;
  onBack: () => void;
  onOpenTask: (taskId: number) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [tasksByColumn, setTasksByColumn] = useState<Map<number, TaskWithMeta[]>>(new Map());
  const [urgent, setUrgent] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showColumnForm, setShowColumnForm] = useState(false);
  const [showLabelForm, setShowLabelForm] = useState(false);
  const [showTaskFormFor, setShowTaskFormFor] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [p, cols, lbls, allTasks, urg] = await Promise.all([
        getProject(projectId),
        listColumns(projectId),
        listLabels(projectId),
        listTasks(projectId),
        listUpcomingUrgentTasks(projectId),
      ]);
      setProject(p);
      setColumns(cols);
      setLabels(lbls);
      setUrgent(urg);

      // Group tasks by column + hydrate
      const byCol = new Map<number, Task[]>();
      for (const t of allTasks) {
        if (!byCol.has(t.column_id)) byCol.set(t.column_id, []);
        byCol.get(t.column_id)!.push(t);
      }
      const hydratedByCol = new Map<number, TaskWithMeta[]>();
      for (const [colId, tasks] of byCol.entries()) {
        hydratedByCol.set(colId, await hydrateTasks(tasks));
      }
      setTasksByColumn(hydratedByCol);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [projectId, onError]);

  useEffect(() => {
    refresh();
    // Realtime: refresh the board when anything in this project changes.
    const unsubTasks = db.subscribe("tasks", { where: { project_id: projectId } }, () => refresh());
    const unsubColumns = db.subscribe("columns", { where: { project_id: projectId } }, () => refresh());
    const unsubLabels = db.subscribe("labels", { where: { project_id: projectId } }, () => refresh());
    const unsubTaskLabels = db.subscribe("task_labels", () => refresh());
    const unsubComments = db.subscribe("comments", () => refresh());
    return () => {
      unsubTasks();
      unsubColumns();
      unsubLabels();
      unsubTaskLabels();
      unsubComments();
    };
  }, [refresh, projectId]);

  const handleCreateColumn = async (name: string) => {
    try {
      await createColumn({
        project_id: projectId,
        name,
        position: columns.length,
      });
      setShowColumnForm(false);
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const handleCreateLabel = async (name: string, color: string) => {
    try {
      await createLabel({ project_id: projectId, name, color });
      setShowLabelForm(false);
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const handleCreateTask = async (columnId: number, title: string, priority: Priority) => {
    try {
      const colTasks = tasksByColumn.get(columnId) ?? [];
      await createTask({
        project_id: projectId,
        column_id: columnId,
        title,
        priority,
        position: colTasks.length,
      });
      setShowTaskFormFor(null);
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  const handleMoveTask = async (taskId: number, targetColumnId: number) => {
    try {
      const targetColTasks = tasksByColumn.get(targetColumnId) ?? [];
      await updateTask(taskId, { column_id: targetColumnId, position: targetColTasks.length });
      await refresh();
    } catch (e) {
      onError(e);
    }
  };

  if (loading) return <div className="empty">Loading…</div>;
  if (!project) return <div className="empty">Project not found.</div>;

  return (
    <>
      <div className="board-header">
        <button className="btn" onClick={onBack}>← Projects</button>
        <span className="color-dot" style={{ background: project.color }} />
        <h2>{project.name}</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-small" onClick={() => setShowLabelForm(true)}>
            + Label
          </button>
          <button className="btn btn-small" onClick={() => setShowColumnForm(true)}>
            + Column
          </button>
        </div>
      </div>

      {urgent.length > 0 && (
        <div className="error-banner" style={{ background: "rgba(245, 158, 11, 0.1)", borderColor: "var(--warning)", color: "var(--warning)" }}>
          ⚠ {urgent.length} urgent task{urgent.length === 1 ? "" : "s"} due in the next 7 days
        </div>
      )}

      {showColumnForm && (
        <NameForm
          title="New Column"
          onCancel={() => setShowColumnForm(false)}
          onSubmit={handleCreateColumn}
        />
      )}

      {showLabelForm && (
        <LabelForm
          onCancel={() => setShowLabelForm(false)}
          onSubmit={handleCreateLabel}
        />
      )}

      {showTaskFormFor !== null && (
        <TaskCreateForm
          columnId={showTaskFormFor}
          onCancel={() => setShowTaskFormFor(null)}
          onSubmit={(title, priority) => handleCreateTask(showTaskFormFor, title, priority)}
        />
      )}

      {columns.length === 0 ? (
        <div className="empty">No columns yet. Click "+ Column" to add one.</div>
      ) : (
        <div className="board">
          {columns.map((col) => {
            const tasks = tasksByColumn.get(col.id) ?? [];
            return (
              <div key={col.id} className="column">
                <div className="column-header">
                  <h3>{col.name} ({tasks.length})</h3>
                  <button
                    className="btn btn-small btn-ghost"
                    title="Delete column"
                    onClick={async () => {
                      if (!confirm(`Delete column "${col.name}" and all its tasks?`)) return;
                      try {
                        await deleteColumn(col.id);
                        await refresh();
                      } catch (e) {
                        onError(e);
                      }
                    }}
                  >✕</button>
                </div>

                <div className="column-tasks">
                  {tasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onClick={() => onOpenTask(t.id)}
                      onMove={(target) => handleMoveTask(t.id, target)}
                      columns={columns}
                      currentColumnId={col.id}
                    />
                  ))}
                </div>

                <button
                  className="btn btn-small"
                  onClick={() => setShowTaskFormFor(col.id)}
                >
                  + Add task
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Label legend */}
      {labels.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h4 style={{ margin: "0 0 6px", fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>
            Labels in this project
          </h4>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {labels.map((l) => (
              <span key={l.id} className="label-badge" style={{ background: l.color }}>
                {l.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function TaskCard({
  task,
  onClick,
  onMove,
  columns,
  currentColumnId,
}: {
  task: TaskWithMeta;
  onClick: () => void;
  onMove: (targetColumnId: number) => void;
  columns: Column[];
  currentColumnId: number;
}) {
  const isOverdue = task.due_date && new Date(task.due_date) < new Date();
  return (
    <div className="task-card" onClick={onClick}>
      <p className="title">{task.title}</p>
      <div className="badges">
        <span className={`priority-badge priority-${task.priority}`}>{task.priority}</span>
        {task.labels.map((l) => (
          <span key={l.id} className="label-badge" style={{ background: l.color }}>
            {l.name}
          </span>
        ))}
        {task.due_date && (
          <span className={`due-badge ${isOverdue ? "overdue" : ""}`}>
            {new Date(task.due_date).toLocaleDateString()}
          </span>
        )}
        {task.comment_count > 0 && (
          <span className="comment-count">💬 {task.comment_count}</span>
        )}
      </div>
      {columns.length > 1 && (
        <div style={{ marginTop: 8, display: "flex", gap: 4 }}>
          {columns.filter((c) => c.id !== currentColumnId).map((c) => (
            <button
              key={c.id}
              className="btn btn-small"
              onClick={(e) => {
                e.stopPropagation();
                onMove(c.id);
              }}
            >
              → {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCreateForm({
  columnId: _columnId,
  onCancel,
  onSubmit,
}: {
  columnId: number;
  onCancel: () => void;
  onSubmit: (title: string, priority: Priority) => void;
}) {
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  return (
    <form
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        onSubmit(title.trim(), priority);
      }}
    >
      <div className="modal">
        <h2>New Task</h2>
        <div className="form-field">
          <label>Title</label>
          <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">Create</button>
        </div>
      </div>
    </form>
  );
}

function NameForm({
  title,
  onCancel,
  onSubmit,
}: {
  title: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim());
      }}
    >
      <div className="modal">
        <h2>{title}</h2>
        <div className="form-field">
          <label>Name</label>
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">Create</button>
        </div>
      </div>
    </form>
  );
}

function LabelForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (name: string, color: string) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#10b981");
  return (
    <form
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim(), color);
      }}
    >
      <div className="modal">
        <h2>New Label</h2>
        <div className="form-field">
          <label>Name</label>
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">Create</button>
        </div>
      </div>
    </form>
  );
}

// ──────────────────────────────────────────────────────────────
// Task detail view
// ──────────────────────────────────────────────────────────────

function TaskDetailView({
  projectId: _projectId,
  taskId,
  onError,
  onBack,
}: {
  projectId: number;
  taskId: number;
  onError: (e: unknown) => void;
  onBack: () => void;
}) {
  void _projectId;
  const [task, setTask] = useState<Task | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [taskLabels, setTaskLabels] = useState<Set<number>>(new Set());
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch the task
      const { data: t, error: tErr } = await db
        .from<Task>("tasks")
        .select("*")
        .eq("id", taskId)
        .single();
      if (tErr) throw new Error(tErr);
      setTask(t);

      // Fetch all labels for the project
      const lbls = await listLabels(t!.project_id);
      setLabels(lbls);

      // Fetch this task's label associations
      const { data: links } = await db
        .from<{ task_id: number; label_id: number }[]>("task_labels")
        .select("*")
        .eq("task_id", taskId);
      setTaskLabels(new Set((links ?? []).map((l) => l.label_id)));

      // Fetch comments
      setComments(await listComments(taskId));
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [taskId, onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async (patch: Partial<Task>) => {
    try {
      const updated = await updateTask(taskId, patch);
      setTask(updated);
    } catch (e) {
      onError(e);
    }
  };

  const handleToggleLabel = async (labelId: number) => {
    try {
      const next = new Set(taskLabels);
      if (next.has(labelId)) next.delete(labelId);
      else next.add(labelId);
      setTaskLabels(next);
      await saveTaskLabels(taskId, [...next]);
    } catch (e) {
      onError(e);
    }
  };

  const handleAddComment = async (author: string, body: string) => {
    try {
      await createComment({ task_id: taskId, author, body });
      setComments(await listComments(taskId));
    } catch (e) {
      onError(e);
    }
  };

  const handleDeleteComment = async (id: number) => {
    try {
      await deleteComment(id);
      setComments(await listComments(taskId));
    } catch (e) {
      onError(e);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this task and all its comments?")) return;
    try {
      await deleteTask(taskId);
      onBack();
    } catch (e) {
      onError(e);
    }
  };

  if (loading || !task) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="board-header">
        <button className="btn" onClick={onBack}>← Board</button>
        <h2>Task #{task.id}</h2>
        <div style={{ marginLeft: "auto" }}>
          <button className="btn btn-danger" onClick={handleDelete}>Delete Task</button>
        </div>
      </div>

      <div className="modal" style={{ maxWidth: "none", margin: 0 }}>
        <div className="task-detail">
          <input
            className="modal"
            style={{
              border: "none",
              padding: 0,
              fontSize: 18,
              fontWeight: 600,
              marginBottom: 8,
              background: "transparent",
            }}
            value={task.title}
            onChange={(e) => setTask({ ...task, title: e.target.value })}
            onBlur={() => handleSave({ title: task.title })}
          />

          <div className="meta-row">
            <span className={`priority-badge priority-${task.priority}`}>{task.priority}</span>
            {task.due_date && (
              <span className={`due-badge ${new Date(task.due_date) < new Date() ? "overdue" : ""}`}>
                Due {new Date(task.due_date).toLocaleDateString()}
              </span>
            )}
            <span>Created {new Date(task.created_at).toLocaleString()}</span>
          </div>

          <div className="form-field">
            <label>Description</label>
            <textarea
              value={task.description ?? ""}
              placeholder="No description."
              onChange={(e) => setTask({ ...task, description: e.target.value })}
              onBlur={() => handleSave({ description: task.description })}
            />
          </div>

          <div className="form-field">
            <label>Priority</label>
            <select
              value={task.priority}
              onChange={(e) => {
                const p = e.target.value as Priority;
                setTask({ ...task, priority: p });
                handleSave({ priority: p });
              }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>

          <div className="form-field">
            <label>Due date</label>
            <input
              type="date"
              value={task.due_date ? task.due_date.slice(0, 10) : ""}
              onChange={(e) => {
                const v = e.target.value;
                const iso = v ? new Date(v).toISOString() : null;
                setTask({ ...task, due_date: iso });
                handleSave({ due_date: iso });
              }}
            />
          </div>

          <div className="section">
            <h4>Labels</h4>
            {labels.length === 0 ? (
              <div className="empty">No labels in this project. Create some from the board.</div>
            ) : (
              <div className="label-checkboxes">
                {labels.map((l) => (
                  <label key={l.id} style={{ borderColor: l.color }}>
                    <input
                      type="checkbox"
                      checked={taskLabels.has(l.id)}
                      onChange={() => handleToggleLabel(l.id)}
                    />
                    <span className="label-badge" style={{ background: l.color }}>{l.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <h4>Comments ({comments.length})</h4>
            <CommentForm onSubmit={handleAddComment} />
            <div style={{ marginTop: 12 }}>
              {comments.length === 0 ? (
                <div className="empty">No comments yet.</div>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="comment">
                    <span className="author">{c.author}</span>
                    <span className="time">{new Date(c.created_at).toLocaleString()}</span>
                    <button
                      className="btn btn-small btn-danger"
                      style={{ float: "right" }}
                      onClick={() => handleDeleteComment(c.id)}
                    >
                      ✕
                    </button>
                    <div className="body">{c.body}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function CommentForm({
  onSubmit,
}: {
  onSubmit: (author: string, body: string) => void;
}) {
  const session = db.auth.getSession();
  const author = session?.user.email ?? "Anonymous";
  const [body, setBody] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        onSubmit(author, body.trim());
        setBody("");
      }}
    >
      {session ? (
        <div className="comment-as">
          Commenting as <strong>{session.user.email}</strong>
        </div>
      ) : (
        <div className="form-field">
          <input
            placeholder="Your name"
            value={author}
            onChange={() => {}}
          />
        </div>
      )}
      <div className="form-field">
        <textarea
          placeholder="Write a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary btn-small">Post Comment</button>
    </form>
  );
}
