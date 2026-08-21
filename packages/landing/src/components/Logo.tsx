import type { SVGProps } from 'react'

import { cn } from '@/lib/utils'

/** Stacked-table mark. Strokes inherit currentColor so light/dark both work. */
export function LogoMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={cn('size-8', className)}
      {...props}
    >
      <rect x="4" y="5" width="24" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.75" />
      <rect x="4" y="13" width="24" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.75" />
      <rect x="4" y="21" width="24" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.75" />
      <path d="M11 5v22" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  )
}

type WordmarkProps = {
  className?: string
}

export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className="size-7" />
      <span className="font-display text-lg font-semibold leading-none tracking-tight">
        LocalBase
      </span>
    </span>
  )
}
