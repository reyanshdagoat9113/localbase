/**
 * How the user should invoke the CLI in printed hints.
 *
 * When launched through `npx` (npm sets `npm_command=exec`), the `localbase`
 * binary is usually not on PATH, so hints like "run `localbase dev`" would
 * fail if copy-pasted. Print the `npx @localbase/cli` form in that case.
 */
export function cliInvocation(env: NodeJS.ProcessEnv = process.env): string {
  return env.npm_command === "exec" ? "npx @localbase/cli" : "localbase";
}
