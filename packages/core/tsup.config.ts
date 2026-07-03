import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@localbase/shared",
    "@hono/node-server",
    "better-sqlite3",
    "node:fs",
    "node:path",
    "node:url",
  ],
});
