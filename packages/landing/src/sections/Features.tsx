import { Check } from 'lucide-react'

import { Screenshot } from '@/components/Screenshot'
import { featureRows, featureScreenshot, type FeatureRow } from '@/config/content'
import { type ScreenshotId } from '@/config/screenshots'
import { cn } from '@/lib/utils'

function hasShot(row: FeatureRow): row is FeatureRow & { id: ScreenshotId } {
  return row.showScreenshot !== false && (row.id === 'studio' || row.id === 'table')
}

export function Features() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="eyebrow">Features</p>
        <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Schema, API, SDK, and Studio — one process
        </h2>
        <p className="mt-3 text-pretty text-muted-foreground">
          Built for local development and prototypes. Honest about what it is not.
        </p>
      </div>

      <div className="mt-14 flex flex-col gap-16 sm:mt-20 sm:gap-24">
        {featureRows.map((row) =>
          hasShot(row) ? <ShotRow key={row.id} row={row} /> : <SummaryRow key={row.id} row={row} />,
        )}
      </div>
    </section>
  )
}

function SummaryRow({ row }: { row: FeatureRow }) {
  return (
    <article
      aria-labelledby={`feature-${row.id}`}
      className="rounded-xl border border-border/60 bg-muted/20 p-6 sm:p-10"
    >
      <div className="max-w-2xl">
        <FeatureHeader row={row} />
        <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">{row.body}</p>
      </div>
      <FeatureBullets
        bullets={row.bullets}
        className="mt-8 border-t border-border/50 pt-6 sm:grid sm:grid-cols-3 sm:gap-6"
      />
    </article>
  )
}

function ShotRow({ row }: { row: FeatureRow & { id: ScreenshotId } }) {
  return (
    <article aria-labelledby={`feature-${row.id}`} className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <div className="max-w-2xl">
          <FeatureHeader row={row} />
        </div>
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-12">
          <p className="text-pretty leading-relaxed text-muted-foreground">{row.body}</p>
          <FeatureBullets bullets={row.bullets} />
        </div>
      </div>
      <Screenshot shot={featureScreenshot(row.id)} />
    </article>
  )
}

function FeatureHeader({ row }: { row: FeatureRow }) {
  return (
    <>
      <p className="eyebrow">{row.eyebrow}</p>
      <h3
        id={`feature-${row.id}`}
        className="mt-3 font-display text-2xl font-semibold tracking-tight sm:text-3xl"
      >
        {row.title}
      </h3>
    </>
  )
}

function FeatureBullets({ bullets, className }: { bullets: string[]; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2.5', className)}>
      {bullets.map((bullet) => (
        <li key={bullet} className="flex items-start gap-2.5 text-sm leading-relaxed">
          <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <span className="text-muted-foreground">{bullet}</span>
        </li>
      ))}
    </ul>
  )
}
