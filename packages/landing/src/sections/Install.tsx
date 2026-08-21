import { CopyCommand } from '@/components/CopyCommand'
import { INIT_COMMAND, NPM_CLI_URL, NPM_SDK_URL, STUDIO_COMMAND, siteMeta } from '@/config/site'

export function Install() {
  return (
    <section
      id="install"
      aria-labelledby="install-heading"
      className="border-y border-border/40 bg-muted/15"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Install</p>
          <h2
            id="install-heading"
            className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            npm, then localhost:5180
          </h2>
          <p className="mt-3 text-pretty text-muted-foreground">
            Requires Node.js 22 or newer. The CLI package is @localbase/cli — there is no package
            named just localbase.
          </p>
        </div>

        <ol className="mx-auto mt-10 grid max-w-3xl gap-4">
          <li>
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/70 p-5 sm:p-6">
              <p className="text-sm font-medium">1. Scaffold a project</p>
              <CopyCommand command={INIT_COMMAND} />
            </div>
          </li>
          <li>
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/70 p-5 sm:p-6">
              <p className="text-sm font-medium">2. Start the API and Admin Studio</p>
              <CopyCommand command={STUDIO_COMMAND} />
              <p className="text-xs text-muted-foreground">
                REST at http://localhost:5180 · Studio at http://localhost:5180/admin/
              </p>
            </div>
          </li>
        </ol>

        <p className="mx-auto mt-8 max-w-3xl text-center text-sm text-muted-foreground">
          Packages:{' '}
          <a className="text-brand hover:underline" href={NPM_CLI_URL} target="_blank" rel="noreferrer">
            @localbase/cli
          </a>
          {' · '}
          <a className="text-brand hover:underline" href={NPM_SDK_URL} target="_blank" rel="noreferrer">
            @localbase/sdk
          </a>
          {' · '}
          <a className="text-brand hover:underline" href={siteMeta.docsUrl} target="_blank" rel="noreferrer">
            Getting started
          </a>
        </p>
      </div>
    </section>
  )
}
