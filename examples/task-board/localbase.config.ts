export default {
  auth: {
    enabled: true,
    jwtSecret: process.env.JWT_SECRET ?? "task-board-dev-secret",
    accessTokenExpiry: "1h",
    refreshTokenExpiry: 30 * 24 * 60 * 60, // 30 days
    minPasswordLength: 6,
  },

  tables: {
    projects: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      // RLS owner column. The API stamps the authenticated user's id here on
      // insert and filters by it on read, so a board only ever shows for the
      // account that created it. Nullable so adding the column migrates cleanly
      // over an existing db (pre-RLS boards get NULL and become hidden).
      owner_id: { type: "integer" },
      name: { type: "text", nullable: false },
      description: { type: "text" },
      color: { type: "text", default: "'#3b82f6'" },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    columns: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      project_id: { type: "integer", references: { table: "projects", column: "id" } },
      name: { type: "text", nullable: false },
      position: { type: "integer", default: "0" },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    labels: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      project_id: { type: "integer", references: { table: "projects", column: "id" } },
      name: { type: "text", nullable: false },
      color: { type: "text", default: "'#6b7280'" },
    },
    tasks: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      project_id: { type: "integer", references: { table: "projects", column: "id" } },
      column_id: { type: "integer", references: { table: "columns", column: "id" } },
      title: { type: "text", nullable: false },
      description: { type: "text" },
      position: { type: "integer", default: "0" },
      priority: { type: "text", default: "'medium'" }, // low | medium | high | urgent
      due_date: { type: "text" }, // ISO date or null
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    task_labels: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      task_id: { type: "integer", references: { table: "tasks", column: "id" } },
      label_id: { type: "integer", references: { table: "labels", column: "id" } },
    },
    comments: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      task_id: { type: "integer", references: { table: "tasks", column: "id" } },
      author: { type: "text", nullable: false },
      body: { type: "text", nullable: false },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
  },

  // Row-Level Security: boards are scoped to the user who created them. This is
  // what keeps account A's boards from showing up when signed in as account B.
  // (Child tables like tasks/columns could be scoped the same way by adding an
  // owner column and an entry here — projects alone fixes the reported leak.)
  policies: {
    projects: { ownerColumn: "owner_id" },
  },
};
