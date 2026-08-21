import { ArrowRight, Github } from 'lucide-react'

import { CopyCommand } from '@/components/CopyCommand'
import { SchemaCard } from '@/components/SchemaCard'
import { Screenshot } from '@/components/Screenshot'
import { Button } from '@/components/ui'
import { heroScreenshot } from '@/config/screenshots'
import { APP_VERSION, GITHUB_URL, INIT_COMMAND } from '@/config/site'

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pb-20 sm:pt-20 lg:pt-24">
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center animate-slide-up">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            v{APP_VERSION} · developer preview · Node.js ≥ 22
          </p>

          <h1 className="font-display text-balance text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl md:text-6xl">
            Your schema file is the backend
          </h1>

          <p className="max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
            Define tables in TypeScript. Get SQLite, a REST API, an SDK, and Admin Studio on
            localhost — no Docker, no cloud account.
          </p>

          <CopyCommand command={INIT_COMMAND} className="w-full max-w-md" />

          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild variant="brand" size="xl">
              <a href="#install">Get started</a>
            </Button>
            <Button asChild variant="outline" size="xl">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                <Github className="size-4" />
                View on GitHub
                <ArrowRight className="size-4 opacity-60" />
              </a>
            </Button>
          </div>
        </div>

        <div className="relative mx-auto mt-14 max-w-5xl animate-fade-in delay-150 sm:mt-16 lg:mt-20 lg:pb-16">
          <Screenshot shot={heroScreenshot} priority className="relative" />
          <SchemaCard className="mt-4 lg:absolute lg:-bottom-10 lg:-left-8 lg:mt-0 lg:w-[22.5rem]" />
        </div>
      </div>
    </section>
  )
}
