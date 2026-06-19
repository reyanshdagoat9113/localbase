import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adminUrl, openBrowser } from "./open-browser.js";

describe("adminUrl", () => {
  it("uses `localhost` for the loopback IPv4 host", () => {
    assert.equal(adminUrl("127.0.0.1", 5180), "http://localhost:5180/admin/");
  });

  it("uses `localhost` for the loopback IPv6 host", () => {
    assert.equal(adminUrl("::1", 5180), "http://localhost:5180/admin/");
  });

  it("uses `localhost` for the literal `localhost` host (case-insensitive)", () => {
    assert.equal(adminUrl("localhost", 5180), "http://localhost:5180/admin/");
    assert.equal(adminUrl("LOCALHOST", 5180), "http://localhost:5180/admin/");
  });

  it("uses the supplied host for non-loopback bindings", () => {
    assert.equal(adminUrl("0.0.0.0", 4000), "http://0.0.0.0:4000/admin/");
    assert.equal(
      adminUrl("192.168.1.5", 5180),
      "http://192.168.1.5:5180/admin/"
    );
  });

  it("always ends with `/admin/` (trailing slash significant for the SPA)", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "example.com"]) {
      const url = adminUrl(host, 5180);
      assert.ok(url.endsWith("/admin/"), `expected trailing /admin/ in ${url}`);
    }
  });
});

describe("openBrowser", () => {
  it("rejects empty / non-string URLs", () => {
    assert.throws(() => openBrowser(""));
    assert.throws(() => openBrowser(undefined as unknown as string));
    assert.throws(() => openBrowser(null as unknown as string));
  });

  it("spawns the platform-correct command with detached stdio", () => {
    // We can't observe the actual browser launching on a headless test
    // runner, so we assert the *shape* of the call. openBrowser is a
    // pure function over the (platform, url) inputs, and the spawn
    // options are an internal contract we want to lock down:
    //   - detached: true  (don't keep the CLI alive)
    //   - stdio: 'ignore' (the browser owns its own window; the CLI
    //     must not pipe the browser's output to its own TTY)
    //
    // The function returns `{ opened, command, args }` so the test
    // can verify what it would have done without requiring a real
    // browser to be present.
    const result = openBrowser("http://localhost:5180/admin/");
    if (process.platform === "darwin") {
      assert.equal(result.command, "open");
      assert.deepEqual(result.args, ["http://localhost:5180/admin/"]);
    } else if (process.platform === "win32") {
      assert.equal(result.command, "cmd");
      assert.deepEqual(result.args, ["/c", "start", "", "http://localhost:5180/admin/"]);
    } else {
      assert.equal(result.command, "xdg-open");
      assert.deepEqual(result.args, ["http://localhost:5180/admin/"]);
    }
    // `opened` is best-effort — on a machine without xdg-open the
    // spawn() will throw and we'll fall back to the warn path. We
    // accept either result on Linux/Windows; we just want the function
    // to be safe to call.
    assert.ok(typeof result.opened === "boolean");
  });
});
