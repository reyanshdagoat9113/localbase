import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    "@localbase/shared",
    "@localbase/core",
    "commander",
    "picocolors",
    "jiti",
    "@hono/node-server",
    "hono",
    "better-sqlite3",
  ],
});
