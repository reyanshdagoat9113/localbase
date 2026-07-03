/**
 * The ungated-admin public-binding safety policy — Decision #10 of the admin
 * plan, factored out of `dev.ts` into a dependency-free module so it can be
 * unit-tested without loading the rest of the CLI (which pulls in
 * `@localbase/core` and its built `dist/`).
 *
 * The rule: an admin API mounted with auth disabled is UNGATED (full read/write
 * access to every table). It must never be exposed on a non-local interface by
 * accident. The CLI enforces that here; core cannot know the binding.
 */

/** Addresses that count as "local" for the ungated-admin safety policy. */
export const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

/**
 * Returns an error message if mounting the admin API with the given settings
 * would expose an ungated admin surface on a public interface, or `null` if
 * the configuration is safe.
 *
 * Safe (returns null):
 *   - auth is enabled (the admin API is gated by `requireAdmin`), OR
 *   - admin is disabled entirely, OR
 *   - the caller explicitly opted in with `--admin-unsafe-public`, OR
 *   - the host is a loopback address (case-insensitive).
 *
 * Unsafe (returns a guidance message): auth disabled + admin enabled + a
 * non-loopback host + no explicit opt-in.
 */
export function unsafeAdminBinding(
  host: string,
  authEnabled: boolean,
  adminEnabled: boolean,
  optedInUnsafe: boolean
): string | null {
  if (authEnabled || !adminEnabled) return null; // gated, or admin off
  if (optedInUnsafe) return null; // explicit opt-in
  const isLocal = LOCALHOST_HOSTS.has(host.toLowerCase());
  if (isLocal) return null;
  return (
    `Admin UI is enabled and auth is disabled, which leaves the admin API ` +
    `UNGATED (full read/write access to every table). Refusing to bind to ` +
    `"${host}" because that would expose it beyond this machine.\n` +
    `To proceed, choose one of:\n` +
    `  - Enable auth in localbase.config.ts (recommended)\n` +
    `  - Bind to loopback: --host 127.0.0.1\n` +
    `  - Acknowledge the risk and continue: --admin-unsafe-public`
  );
}
