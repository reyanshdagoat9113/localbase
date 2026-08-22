import { Check } from 'lucide-react'

import { steps } from '@/config/content'

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24"
    >
      <div className="mx-auto max-w-2xl text-center">
        <p className="eyebrow">Get started</p>
        <h2
          id="how-it-works-heading"
          className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          Three commands, then a running API
        </h2>
      </div>

      <ol className="mt-12 grid gap-4 md:grid-cols-3 md:gap-6">
        {steps.map((step) => (
          <li
            key={step.n}
            className="flex h-full flex-col gap-3 rounded-xl border border-border/60 bg-card/70 p-6"
          >
            <span
              aria-hidden="true"
              className="font-display text-2xl font-semibold text-muted-foreground/40"
            >
              {String(step.n).padStart(2, '0')}
            </span>
            <h3 className="text-lg font-medium">{step.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            <p className="mt-auto flex items-center gap-2 pt-2 text-sm font-medium">
              <Check className="size-4 shrink-0 text-brand" aria-hidden="true" />
              {step.result}
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}
