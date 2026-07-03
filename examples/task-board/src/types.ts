export type Priority = "low" | "medium" | "high" | "urgent";

export interface Project {
  id: number;
  name: string;
  description: string | null;
  color: string;
  created_at: string;
}

export interface Column {
  id: number;
  project_id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface Label {
  id: number;
  project_id: number;
  name: string;
  color: string;
}

export interface Task {
  id: number;
  project_id: number;
  column_id: number;
  title: string;
  description: string | null;
  position: number;
  priority: Priority;
  due_date: string | null;
  created_at: string;
}

export interface TaskLabel {
  id: number;
  task_id: number;
  label_id: number;
}

export interface Comment {
  id: number;
  task_id: number;
  author: string;
  body: string;
  created_at: string;
}

export interface TaskWithMeta extends Task {
  labels: Label[];
  comment_count: number;
}
