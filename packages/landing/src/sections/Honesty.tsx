import { X } from 'lucide-react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui'
import { faq, nonGoals } from '@/config/content'

export function Honesty() {
  return (
    <section aria-label="Scope and questions" className="border-t border-border/40">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-16 sm:gap-16 sm:px-6 sm:py-24 lg:grid-cols-2">
        <div role="region" aria-labelledby="honesty">
          <p className="eyebrow">Scope</p>
          <h2
            id="honesty"
            className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            What LocalBase is not
          </h2>
          <p className="mt-3 text-pretty text-muted-foreground">
            The developer preview is a single-process SQLite backend. These are current limits, not
            a disguised roadmap.
          </p>

          <ul className="mt-8 grid gap-2">
            {nonGoals.map((item) => (
              <li
                key={item}
                className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-3"
              >
                <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-sm font-medium">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div role="region" aria-labelledby="faq-heading">
          <p className="eyebrow">FAQ</p>
          <h2
            id="faq-heading"
            className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            Questions
          </h2>

          <Accordion type="single" collapsible className="mt-6">
            {faq.map((item, index) => (
              <AccordionItem key={item.question} value={`faq-${index}`}>
                <AccordionTrigger className="text-left text-sm sm:text-base">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  )
}
