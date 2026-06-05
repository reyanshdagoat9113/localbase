export default {
  tables: {
    projects: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
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
};
