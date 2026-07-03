import type { LocalBaseConfig } from "@localbase/shared";

export default {
  tables: {
    tasks: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "text", nullable: false },
      done: { type: "boolean", default: "0" },
      created_at: { type: "text", default: "CURRENT_TIMESTAMP" },
    },
    notes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      body: { type: "text" },
    },
  },
  auth: {
    enabled: true,
    jwtSecret: "smoke-test-secret-do-not-use-in-prod",
  },
} satisfies LocalBaseConfig;
