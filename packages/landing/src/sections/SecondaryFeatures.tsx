import { secondaryFeatures } from '@/config/content'

export function SecondaryFeatures() {
  return (
    <section
      aria-labelledby="more-features"
      className="border-y border-border/40 bg-muted/15"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="max-w-2xl">
          <p className="eyebrow">Also included</p>
          <h2
            id="more-features"
            className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Auth, realtime, Storage, and Jobs — when you need them
          </h2>
        </div>

        <ul className="mt-12 grid gap-x-12 border-t border-border/40 sm:grid-cols-2">
          {secondaryFeatures.map(({ key, body }) => (
            <li key={key} className="flex gap-4 border-b border-border/40 py-5">
              <span className="w-24 shrink-0 pt-px font-mono text-xs font-medium text-foreground/90">
                {key}
              </span>
              <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
