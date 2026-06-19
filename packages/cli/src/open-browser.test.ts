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

  it("selects the platform-correct command with detached stdio", () => {
    const cases: Array<{
      platform: NodeJS.Platform;
      command: string;
      args: string[];
    }> = [
      { platform: "darwin", command: "open", args: ["http://localhost:5180/admin/"] },
      {
        platform: "win32",
        command: "cmd",
        args: ["/c", "start", "", "http://localhost:5180/admin/"],
      },
      { platform: "linux", command: "xdg-open", args: ["http://localhost:5180/admin/"] },
    ];

    for (const expected of cases) {
      let unrefCalled = false;
      let errorHandler: ((err: Error) => void) | undefined;
      const calls: Array<{ command: string; args: string[]; options: unknown }> = [];

      const result = openBrowser("http://localhost:5180/admin/", {
        platform: expected.platform,
        spawn(command, args, options) {
          calls.push({ command, args, options });
          return {
            unref() {
              unrefCalled = true;
            },
            on(event, listener) {
              if (event === "error") errorHandler = listener;
              return this;
            },
          };
        },
      });

      assert.equal(result.opened, true);
      assert.equal(result.command, expected.command);
      assert.deepEqual(result.args, expected.args);
      assert.deepEqual(calls, [
        {
          command: expected.command,
          args: expected.args,
          options: { detached: true, stdio: "ignore" },
        },
      ]);
      assert.equal(unrefCalled, true);
      assert.equal(typeof errorHandler, "function");
    }
  });

  it("handles async spawn failures without throwing", () => {
    let errorHandler: ((err: Error) => void) | undefined;
    const result = openBrowser("http://localhost:5180/admin/", {
      platform: "linux",
      spawn() {
        return {
          on(event, listener) {
            if (event === "error") errorHandler = listener;
            return this;
          },
        };
      },
    });

    assert.equal(result.opened, true);
    assert.doesNotThrow(() => errorHandler?.(new Error("spawn xdg-open ENOENT")));
  });

  it("returns opened=false when spawn throws synchronously", () => {
    const result = openBrowser("http://localhost:5180/admin/", {
      platform: "linux",
      spawn() {
        throw new Error("boom");
      },
    });

    assert.equal(result.opened, false);
    assert.equal(result.command, "xdg-open");
    assert.deepEqual(result.args, ["http://localhost:5180/admin/"]);
  });
});
