import { ArrowRight, Github } from 'lucide-react'

import { CopyCommand } from '@/components/CopyCommand'
import { SceneAct } from '@/components/SceneAct'
import { Button } from '@/components/ui'
import { heroScreenshot } from '@/config/screenshots'
import { APP_VERSION, GITHUB_URL, INIT_COMMAND } from '@/config/site'
import { Features } from '@/sections/Features'
import { Footer } from '@/sections/Footer'
import { Honesty } from '@/sections/Honesty'
import { HowItWorks } from '@/sections/HowItWorks'
import { Install } from '@/sections/Install'
import { Nav } from '@/sections/Nav'
import { SecondaryFeatures } from '@/sections/SecondaryFeatures'
import { TrustStrip } from '@/sections/TrustStrip'

const act = '[&>section]:py-24 sm:[&>section]:py-32'

/**
 * Cinematic: the Studio as a full-viewport opening shot with a slow push-in,
 * headline anchored bottom-left, then generously spaced acts that fade up
 * as they enter. One screen, one idea at a time.
 */
export function SceneLayout() {
  return (
    <>
      <Nav overlay />

      <section id="top" className="relative flex min-h-svh items-end overflow-hidden">
        <div aria-hidden="true" className="absolute inset-0">
          <img
            src={heroScreenshot.src}
            alt=""
            fetchPriority="high"
            decoding="sync"
            className="scene-drift size-full object-cover object-left-top saturate-[0.9]"
          />
          <div className="absolute inset-0 bg-background/70 dark:bg-background/60" />
          {/* Top veil keeps the overlay nav legible over the shot. */}
          <div className="absolute inset-x-0 top-0 h-52 bg-gradient-to-b from-background/95 via-background/40 to-transparent" />
          {/* Bottom gradient anchors the headline block. */}
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
        </div>

        <div className="relative mx-auto w-full max-w-6xl px-4 pb-20 pt-32 sm:px-6 sm:pb-28 animate-slide-up">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/85 drop-shadow-[0_1px_6px_rgba(0,0,0,0.45)]">
            v{APP_VERSION} · developer preview · Node.js ≥ 22
          </p>

          <h1 className="mt-5 max-w-3xl font-display text-5xl font-semibold leading-[1.05] tracking-tight drop-shadow-[0_2px_16px_rgba(0,0,0,0.45)] sm:text-6xl lg:text-7xl">
            Your schema file is the backend
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-base font-medium leading-relaxed text-foreground/95 drop-shadow-[0_1px_8px_rgba(0,0,0,0.4)] sm:text-lg">
            Define tables in TypeScript. Get SQLite, a REST API, an SDK, and Admin Studio on
            localhost — no Docker, no cloud account.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <CopyCommand command={INIT_COMMAND} className="w-full max-w-md" />
            <Button asChild variant="brand" size="xl">
              <a href="#install">Get started</a>
            </Button>
            <Button asChild variant="outline" size="xl">
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                <Github className="size-4" />
                GitHub
                <ArrowRight className="size-4 opacity-60" />
              </a>
            </Button>
          </div>
        </div>

        {/* Scroll cue — countdown-leader line. */}
        <div
          aria-hidden="true"
          className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 md:flex"
        >
          <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-foreground/50">
            scroll
          </span>
          <span className="scene-cue block h-8 w-px bg-gradient-to-b from-foreground/60 to-transparent" />
        </div>
      </section>

      <main id="main">
        <TrustStrip />
        <SceneAct className={act}>
          <Features />
        </SceneAct>
        <SceneAct className={act}>
          <SecondaryFeatures />
        </SceneAct>
        <SceneAct className={act}>
          <HowItWorks />
        </SceneAct>
        <SceneAct className={act}>
          <Install />
        </SceneAct>
        <SceneAct className={act}>
          <Honesty />
        </SceneAct>
      </main>
      <Footer />
    </>
  )
}
