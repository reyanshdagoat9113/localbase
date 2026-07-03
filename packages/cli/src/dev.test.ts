import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unsafeAdminBinding, LOCALHOST_HOSTS } from "./admin-bind-policy.js";

/**
 * M2.5 — the most critical startup safety control.
 *
 * `unsafeAdminBinding` decides whether `localbase dev` is allowed to bind at
 * all when the admin API would be ungated. A one-line inversion here would
 * expose full read/write admin access to the LAN/internet, so the entire truth
 * table is pinned. The function is pure (no I/O), so we call it directly.
 */
describe("unsafeAdminBinding (Decision #10: no ungated admin on public interfaces)", () => {
  // [host, authEnabled, adminEnabled, optedInUnsafe]
  const SAFE: ReadonlyArray<readonly [string, boolean, boolean, boolean]> = [
    ["0.0.0.0", true, true, false], // auth on → gated, host irrelevant
    ["0.0.0.0", true, false, false], // auth on, admin off
    ["0.0.0.0", false, false, false], // admin off entirely
    ["example.com", false, false, false], // admin off
    ["0.0.0.0", false, true, true], // explicit opt-in
    ["example.com", false, true, true], // explicit opt-in
    ["127.0.0.1", false, true, false], // loopback
    ["localhost", false, true, false], // loopback
    ["::1", false, true, false], // IPv6 loopback
    ["LOCALHOST", false, true, false], // case-insensitive
    ["127.0.0.1", false, true, true], // loopback + opt-in (redundant but safe)
  ];

  const UNSAFE: ReadonlyArray<readonly [string, boolean, boolean, boolean]> = [
    ["0.0.0.0", false, true, false], // all-interfaces, no auth, no opt-in
    ["example.com", false, true, false],
    ["192.168.1.5", false, true, false], // LAN address
    ["10.0.0.1", false, true, false],
    ["::", false, true, false], // IPv6 wildcard
    ["[::]", false, true, false],
  ];

  for (const [host, auth, admin, opt] of SAFE) {
    it(`is safe (null): host=${host} auth=${auth} admin=${admin} opt-in=${opt}`, () => {
      assert.equal(
        unsafeAdminBinding(host, auth, admin, opt),
        null,
        `expected null for host=${host} auth=${auth} admin=${admin} opt=${opt}`
      );
    });
  }

  for (const [host, auth, admin, opt] of UNSAFE) {
    it(`refuses (non-null): host=${host} auth=${auth} admin=${admin} opt-in=${opt}`, () => {
      const msg = unsafeAdminBinding(host, auth, admin, opt);
      assert.notEqual(msg, null, `expected refusal for host=${host}`);
      // The message must steer the user toward the three safe options.
      assert.match(msg!, /UNGATED/);
      assert.match(msg!, /--admin-unsafe-public/);
      assert.match(msg!, /127\.0\.0\.1/);
      assert.ok(msg!.includes(`"${host}"`), "message names the offending host");
    });
  }

  it("LOCALHOST_HOSTS contains the canonical loopback set", () => {
    assert.ok(LOCALHOST_HOSTS.has("127.0.0.1"));
    assert.ok(LOCALHOST_HOSTS.has("localhost"));
    assert.ok(LOCALHOST_HOSTS.has("::1"));
    // Bracketed IPv6 loopback is deliberately NOT in the set — serve()
    // normalizes brackets away, so we lock the contract: it is refused.
    assert.equal(LOCALHOST_HOSTS.has("[::1]"), false);
  });
});
