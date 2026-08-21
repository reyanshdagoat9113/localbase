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
            <span className="font-mono text-xs text-muted-foreground">
              {String(step.n).padStart(2, '0')}
            </span>
            <p className="min-w-0 truncate rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12.5px]">
              <span className="text-brand" aria-hidden="true">
                ${' '}
              </span>
              {step.command}
            </p>
            <p className="text-sm font-medium">{step.result}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
