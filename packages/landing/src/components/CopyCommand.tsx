import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

type CopyCommandProps = {
  command: string
  className?: string
}

export function CopyCommand({ command, className }: CopyCommandProps) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-border/70 bg-muted/85 py-1.5 pl-4 pr-1.5 font-mono text-sm backdrop-blur-sm',
        className,
      )}
    >
      <span aria-hidden="true" className="shrink-0 text-brand">
        $
      </span>
      <code className="min-w-0 flex-1 truncate text-left">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        aria-label={copied ? 'Command copied' : 'Copy command'}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
