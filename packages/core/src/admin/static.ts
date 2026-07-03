import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { AdminConfig } from "@localbase/shared";

/**
 * The default directory the build step is expected to copy the admin
 * bundle into. The shape is `<core dist>/admin/`, so the published
 * `@localbase/core` ships the admin UI as part of its tarball.
 */
const DEFAULT_ADMIN_DIST = "admin";

/**
 * Resolve the path to the admin static bundle.
 *
 * The dist/ directory is created by `tsup` next to the compiled .js.
 * In dev mode (running with `tsx`), the .js files don't exist yet and
 * the dist directory is empty — we treat that as "no bundle available"
 * and fall through to the placeholder.
 *
 * Resolution rules (first match wins):
 *   1. `process.env.LOCALBASE_ADMIN_DIST` if set and usable
 *   2. `<workspace>/packages/admin/dist` in this monorepo
 *   3. `<core dist>/admin` (the production path)
 *   4. `<core dist>/../admin` (the workspace-dev path used while
 *      `packages/admin` is being built separately — M3)
 */
export function findAdminDistPath(): string | null {
  if (process.env.LOCALBASE_ADMIN_DIST) {
    return isUsableBundle(process.env.LOCALBASE_ADMIN_DIST)
      ? process.env.LOCALBASE_ADMIN_DIST
      : null;
  }

  const workspaceDist = findWorkspaceAdminDistPath();
  if (workspaceDist) {
    return workspaceDist;
  }

  const distDir = resolveCoreDistDir();
  if (!distDir) return null;

  const candidates = [
    path.join(distDir, DEFAULT_ADMIN_DIST),
    path.join(distDir, "..", DEFAULT_ADMIN_DIST),
  ];

  for (const candidate of candidates) {
    if (isUsableBundle(candidate)) return candidate;
  }
  return null;
}

function findWorkspaceAdminDistPath(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "packages", "admin", "dist");
      if (isLocalbaseWorkspaceRoot(dir) && isUsableBundle(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url may be unavailable in some test runners; fall through.
  }
  return null;
}

function isLocalbaseWorkspaceRoot(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string; workspaces?: unknown };
    return (
      pkg.name === "localbase" &&
      Array.isArray(pkg.workspaces) &&
      pkg.workspaces.includes("packages/admin")
    );
  } catch {
    return false;
  }
}

function resolveCoreDistDir(): string | null {
  // Prefer the standard env var that bundlers set.
  if (process.env.LOCALBASE_CORE_DIST) {
    return process.env.LOCALBASE_CORE_DIST;
  }

  // Walk up from this module until we find a directory that *looks* like
  // the core dist (contains index.js, which tsup emits). This works for
  // both the published package and the local development tree.
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = path.dirname(here);
    for (let i = 0; i < 8; i++) {
      if (
        fs.existsSync(path.join(dir, "index.js")) &&
        fs.existsSync(path.join(dir, "index.d.ts"))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url may be unavailable in some test runners; fall through.
  }
  return null;
}

function isUsableBundle(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  // An empty directory or a directory with no index.html is not a
  // usable SPA bundle.
  return fs.existsSync(path.join(dir, "index.html"));
}

/**
 * Mount the admin SPA static files at `/admin*`.
 *
 * - If a real bundle exists, files are served with Hono's `serveStatic`
 *   helper (with sensible caching headers for hashed assets).
 * - If no bundle exists, every request gets a placeholder HTML response
 *   that explains the situation. This means M1's "Done when
 *   `/admin/` serves a placeholder `index.html`" deliverable is met
 *   even before the React app is built.
 *
 * Routing rules
 * ─────────────
 *   /admin              → index.html (placeholder or real)
 *   /admin/index.html   → index.html
 *   /admin/assets/…     → static asset, 404 if missing
 *   /admin/anything-else → index.html (SPA fallback)
 *
 * The SPA fallback lets the React Router (or similar) own the path
 * space after first load.
 */
export function mountAdminStatic(
  app: Hono,
  config: AdminConfig
): { servingPlaceholder: boolean } {
  if (!config.enabled) {
    return { servingPlaceholder: false };
  }

  const bundleDir = findAdminDistPath();
  const servingPlaceholder = bundleDir === null;

  // Bare `/admin` (no path beyond). The wildcard below requires at
  // least one path segment, so we register this separately.
  app.get("/admin", (c) => {
    if (servingPlaceholder) return c.html(PLACEHOLDER_HTML);
    return c.html(readIndexHtml(bundleDir!));
  });

  // Catch-all for everything under `/admin/`. For requests that look
  // like an asset (have a file extension) we delegate to `serveStatic`;
  // for everything else we fall back to the SPA shell.
  app.use("/admin/*", async (c, next) => {
    if (servingPlaceholder) {
      return c.html(PLACEHOLDER_HTML);
    }

    const url = new URL(c.req.url);
    // Strip the `/admin` prefix so the static middleware sees the
    // in-bundle path (e.g. `/admin/assets/main.js` → `/assets/main.js`).
    const subPath = url.pathname.replace(/^\/admin/, "") || "/";

    // Looks like a real asset (has a file extension)? Try to serve it.
    // Missing assets on a real bundle should 404 — that's a build bug,
    // not a route to handle via SPA fallback.
    if (subPath !== "/" && /\.[a-zA-Z0-9]+$/.test(subPath)) {
      return serveStatic({
        root: bundleDir!,
        rewriteRequestPath: () => subPath,
      })(c, next);
    }

    // Otherwise serve the SPA shell.
    return c.html(readIndexHtml(bundleDir!));
  });

  return { servingPlaceholder };
}

/**
 * Synchronously read `index.html` from a bundle directory. Synchronous
 * reads are fine here because (a) this is served once on initial page
 * load, and (b) admin bundles are tiny — a single file, hot in cache.
 */
function readIndexHtml(bundleDir: string): string {
  return fs.readFileSync(path.join(bundleDir, "index.html"), "utf8");
}

/**
 * A self-contained placeholder served at `/admin` when no SPA bundle is
 * installed. The M1 deliverable is to "serve a placeholder `index.html`"
 * — this also doubles as a developer-friendly landing page that explains
 * the state of the project (admin coming, role gate in M2, etc.).
 */
const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LocalBase Admin</title>
  <style>
    :root {
      --bg: #0b0d10;
      --fg: #e6e8eb;
      --muted: #8a93a0;
      --accent: #6ea8ff;
      --border: #1d2128;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--bg); color: var(--fg);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .wrap { max-width: 720px; margin: 64px auto; padding: 0 24px; }
    h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.01em; }
    .sub { color: var(--muted); margin: 0 0 32px; }
    .card {
      background: #11151a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 24px;
      margin: 16px 0;
    }
    .card h2 { font-size: 15px; margin: 0 0 8px; color: var(--accent); }
    .card p { margin: 0 0 8px; }
    code {
      background: #0a0c0f;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 6px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .pill {
      display: inline-block;
      background: #2a1810;
      color: #f0a868;
      border: 1px solid #4a2c1e;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 12px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .links a {
      color: var(--accent);
      text-decoration: none;
      margin-right: 16px;
    }
    .links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>LocalBase Admin <span class="pill">M1 · placeholder</span></h1>
    <p class="sub">The admin API and static mount are live. The React SPA is not built yet — that's the M3 deliverable.</p>

    <div class="card">
      <h2>What's available right now</h2>
      <p>The <code>GET /_api/admin/schema</code> endpoint returns the full introspected schema for every table (including system tables, flagged with <code>system: true</code>).</p>
      <p>Try: <code>curl http://localhost:5180/_api/admin/schema</code></p>
    </div>

    <div class="card">
      <h2>What's coming</h2>
      <p><strong>M2</strong> — role-based admin gate (<code>role</code> on <code>_users</code>, <code>requireAdmin</code> middleware, <code>localbase admin:promote</code>).</p>
      <p><strong>M3</strong> — React + Vite + Tailwind + shadcn/ui shell, login view, table list.</p>
      <p><strong>M4</strong> — table browser, inline row editor, schema viewer.</p>
      <p><strong>M5</strong> — Auth Manager.</p>
      <p><strong>M6</strong> — build embedding + <code>localbase studio</code> CLI.</p>
    </div>

    <div class="card links">
      <a href="/_api/admin/schema">GET /_api/admin/schema</a>
      <a href="/_api/admin/tables">GET /_api/admin/tables</a>
    </div>
  </div>
</body>
</html>
`;
