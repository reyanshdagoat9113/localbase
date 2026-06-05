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
