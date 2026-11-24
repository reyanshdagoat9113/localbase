/**
 * HTTP-exposure hardening tests (NET-P0 / Workstream 1.3).
 *
 * Covers the configurable CORS, per-IP rate limiting, request-body size guard,
 * and consistent security headers that `createServer` applies from
 * `security: SecurityConfig`. Each describe block builds its own server so the
 * tests stay hermetic (rate-limit buckets, CORS config, etc. don't bleed).
 *
 * These tests exercise the wired `createServer` end-to-end via `app.request`,
 * matching the patterns in `api.test.ts` / `rls.test.ts`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Database } from "./db.js";
import { createServer } from "./api.js";
import type { DatabaseSchema } from "@localbase/shared";
import type { Hono } from "hono";

const testSchema: DatabaseSchema = {
  posts: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    title: { type: "text", nullable: false },
  },
};

const authConfig = {
  enabled: true,
  jwtSecret: "test-secret-key-32-bytes-or-longer",
  accessTokenExpiry: "1h",
  minPasswordLength: 8,
};

function jsonPost(
  body: unknown,
  headers: Record<string, string> = {}
) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function readJson(res: Response) {
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

// ─── CORS: loopback-safe default ───────────────────────────────

describe("CORS default (loopback-only)", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    // No security config → loopback-safe defaults apply.
    app = createServer(db, testSchema, { auth: { enabled: false } });
  });
  after(() => db.close());

  it("reflects a localhost origin", async () => {
    const res = await app.request("/", {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://localhost:3000"
    );
  });

  it("reflects a 127.0.0.1 origin with a port", async () => {
    const res = await app.request("/", {
      headers: { Origin: "https://127.0.0.1:5180" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://127.0.0.1:5180"
    );
  });

  it("reflects a portless localhost origin", async () => {
    const res = await app.request("/", {
      headers: { Origin: "http://localhost" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "http://localhost"
    );
  });

  it("does NOT set ACAO for a non-loopback origin", async () => {
    const res = await app.request("/", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("does not advertise credentials by default", async () => {
    const res = await app.request("/", {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });
});

// ─── CORS: configured allowlist ────────────────────────────────

describe("CORS configured allowlist", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, {
      security: {
        cors: {
          allowedOrigins: ["https://app.example.com"],
          allowCredentials: true,
        },
      },
    });
  });
  after(() => db.close());

  it("allows an explicitly listed origin", async () => {
    const res = await app.request("/", {
      headers: { Origin: "https://app.example.com" },
    });
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://app.example.com"
    );
    assert.equal(
      res.headers.get("access-control-allow-credentials"),
      "true"
    );
  });

  it("denies an origin not in the list (even loopback)", async () => {
    // Once an allowlist is configured, the loopback default no longer applies.
    const res = await app.request("/", {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("denies an unrelated external origin", async () => {
    const res = await app.request("/", {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("answers an allowed OPTIONS preflight with 204 + ACAO", async () => {
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-origin"),
      "https://app.example.com"
    );
  });

  it("answers a denied OPTIONS preflight with no ACAO", async () => {
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

// ─── Rate limiting ─────────────────────────────────────────────

describe("rate limiting (per route, per IP with trustProxy: true)", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema, auth: authConfig });
    app = createServer(db, testSchema, {
      auth: authConfig,
      security: {
        trustProxy: true,
        rateLimits: { windowMs: 1000, max: 3 },
      },
    });
  });
  after(() => db.close());

  it("returns 429 with Retry-After once the per-route budget is exceeded", async () => {
    // Send max+1 requests to /signin from the same IP. Unknown emails make
    // the handler fast (no argon2) but the limiter counts every attempt.
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        "/api/auth/signin",
        jsonPost(
          { email: `nocount${i}@x.com`, password: "whatever123" },
          { "X-Forwarded-For": "203.0.113.1" }
        )
      );
      assert.equal(res.status, 401, `request ${i} should be 401 not limited`);
    }
    const blocked = await app.request(
      "/api/auth/signin",
      jsonPost(
        { email: "still-no@x.com", password: "whatever123" },
        { "X-Forwarded-For": "203.0.113.1" }
      )
    );
    assert.equal(blocked.status, 429);
    const retry = blocked.headers.get("retry-after");
    assert.ok(retry, "Retry-After header must be present on 429");
    const retrySec = Number(retry);
    assert.ok(Number.isInteger(retrySec) && retrySec >= 1);
    const body = (await blocked.json().catch(() => null)) as {
      error?: string;
    } | null;
    assert.equal(body?.error, "Too many requests");
  });

  it("a different route is unaffected (independent per-route counter)", async () => {
    // The IP 203.0.113.2 has used no signup budget; signup and signin are
    // keyed separately, so this must not be limited even though we hammer
    // signin above for the same IP family.
    const res = await app.request(
      "/api/auth/signup",
      jsonPost(
        { email: "fresh@x.com", password: "whatever123" },
        { "X-Forwarded-For": "203.0.113.1" }
      )
    );
    assert.notEqual(res.status, 429);
  });

  it("a fresh IP is unaffected (per-IP keying)", async () => {
    const res = await app.request(
      "/api/auth/signin",
      jsonPost(
        { email: "otherip@x.com", password: "whatever123" },
        { "X-Forwarded-For": "198.51.100.9" }
      )
    );
    assert.notEqual(res.status, 429);
  });
});

describe("rate limiting (trustProxy default false & bucket cap)", () => {
  it("ignores X-Forwarded-For when trustProxy is omitted/false", async () => {
    const db = new Database({ schema: testSchema, auth: authConfig });
    const app = createServer(db, testSchema, {
      auth: authConfig,
      security: { rateLimits: { windowMs: 1000, max: 2 } },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.request(
          "/api/auth/signin",
          jsonPost(
            { email: `spoof${i}@x.com`, password: "whatever123" },
            { "X-Forwarded-For": `203.0.113.${i + 1}` }
          )
        );
        assert.equal(res.status, 401);
      }
      // Rotating X-Forwarded-For must NOT bypass the limit when trustProxy is false.
      const blocked = await app.request(
        "/api/auth/signin",
        jsonPost(
          { email: "spoof3@x.com", password: "whatever123" },
          { "X-Forwarded-For": "198.51.100.99" }
        )
      );
      assert.equal(blocked.status, 429);
    } finally {
      db.close();
    }
  });

  it("enforces maxEntries cap by evicting oldest buckets", async () => {
    const { Hono } = await import("hono");
    const { rateLimit } = await import("./rate-limit.js");
    const app = new Hono();
    app.use(
      "/limited",
      rateLimit({ windowMs: 60_000, max: 1, trustProxy: true, maxEntries: 2 })
    );
    app.get("/limited", (c) => c.json({ ok: true }));

    // IP 1 uses its 1 request and is now rate-limited.
    assert.equal(
      (await app.request("/limited", { headers: { "X-Forwarded-For": "10.0.0.1" } })).status,
      200
    );
    assert.equal(
      (await app.request("/limited", { headers: { "X-Forwarded-For": "10.0.0.1" } })).status,
      429
    );

    // IP 2 and IP 3 fill the cap of 2, evicting IP 1 (oldest).
    assert.equal(
      (await app.request("/limited", { headers: { "X-Forwarded-For": "10.0.0.2" } })).status,
      200
    );
    assert.equal(
      (await app.request("/limited", { headers: { "X-Forwarded-For": "10.0.0.3" } })).status,
      200
    );

    // IP 1 was evicted, so its bucket starts fresh (200).
    assert.equal(
      (await app.request("/limited", { headers: { "X-Forwarded-For": "10.0.0.1" } })).status,
      200
    );
  });

  it("resolves real socket remoteAddress under @hono/node-server instead of collapsing to unknown", async () => {
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");
    const { rateLimit } = await import("./rate-limit.js");

    const app = new Hono();
    app.use("/ping", rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/ping", (c) => c.json({ ok: true }));

    // Exhaust the "unknown" bucket via in-process app.request (no socket).
    assert.equal((await app.request("/ping")).status, 200);
    assert.equal((await app.request("/ping")).status, 429);

    // Start a real @hono/node-server listener on an ephemeral loopback port.
    let port = 0;
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
        (info) => {
          port = info.port;
          resolve(s);
        }
      );
    });

    try {
      // Real HTTP request has socket remoteAddress (127.0.0.1), so it must NOT
      // share the already-exhausted "unknown" bucket.
      const first = await fetch(`http://127.0.0.1:${port}/ping`);
      assert.equal(first.status, 200);

      // Second real HTTP request from the same loopback socket hits 429.
      const second = await fetch(`http://127.0.0.1:${port}/ping`);
      assert.equal(second.status, 429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── Body limit ────────────────────────────────────────────────

describe("request body limit", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, {
      security: { bodyLimitBytes: 100 },
    });
  });
  after(() => db.close());

  it("rejects an oversized JSON body with 413", async () => {
    const res = await app.request(
      "/api/posts",
      jsonPost({ title: "x".repeat(300) })
    );
    assert.equal(res.status, 413);
  });

  it("accepts a body within the limit", async () => {
    const res = await app.request(
      "/api/posts",
      jsonPost({ title: "short" })
    );
    assert.notEqual(res.status, 413);
  });
});

// ─── Security headers ──────────────────────────────────────────

describe("security headers", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, { auth: { enabled: false } });
  });
  after(() => db.close());

  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("sets a Referrer-Policy", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  it("sets a frame-options header (DENY by default)", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });
});

describe("security headers (extra + override)", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    app = createServer(db, testSchema, {
      security: {
        headers: {
          extra: {
            "X-Custom-Header": "yes",
            // Override a default by name.
            "X-Frame-Options": "SAMEORIGIN",
          },
        },
      },
    });
  });
  after(() => db.close());

  it("adds an extra header", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("x-custom-header"), "yes");
  });

  it("lets extra override a default", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  });
});

// ─── Loopback default unchanged (no regression) ────────────────

describe("loopback default unchanged (no regression)", () => {
  let db: Database;
  let app: Hono;

  before(() => {
    db = new Database({ schema: testSchema });
    // No security config at all — anonymous localhost behavior must still work.
    app = createServer(db, testSchema, { auth: { enabled: false } });
    db.insert("posts", [{ title: "hello" }, { title: "world" }]);
  });
  after(() => db.close());

  it("anonymous GET /api/:table still lists rows", async () => {
    const res = await app.request("/api/posts");
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.equal((body!.data as unknown[]).length, 2);
  });

  it("anonymous POST /api/:table still inserts", async () => {
    const res = await app.request("/api/posts", jsonPost({ title: "third" }));
    const { status } = await readJson(res);
    assert.equal(status, 201);
  });

  it("health check still returns ok", async () => {
    const res = await app.request("/");
    const { status, body } = await readJson(res);
    assert.equal(status, 200);
    assert.equal(body!.status, "ok");
  });
});
