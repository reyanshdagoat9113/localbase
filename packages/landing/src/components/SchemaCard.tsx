import { cn } from '@/lib/utils'

type Tok = [text: string, tone: 'key' | 'str' | 'punc' | 'com']

const CONFIG: Tok[][] = [
  [['// localbase.config.ts', 'com']],
  [['export default', 'key'], [' {', 'punc']],
  [['  tables', 'key'], [': {', 'punc']],
  [['    users', 'key'], [': {', 'punc']],
  [['      id', 'key'], [': { type: ', 'punc'], ['"integer"', 'str'], [', primaryKey: ', 'punc'], ['true', 'str'], [' },', 'punc']],
  [['      email', 'key'], [': { type: ', 'punc'], ['"text"', 'str'], [', unique: ', 'punc'], ['true', 'str'], [' },', 'punc']],
  [['    },', 'punc']],
  [['    posts', 'key'], [': {', 'punc']],
  [['      title', 'key'], [': { type: ', 'punc'], ['"text"', 'str'], [' },', 'punc']],
  [['      user_id', 'key'], [': { references: ', 'punc'], ['"users.id"', 'str'], [' },', 'punc']],
  [['    },', 'punc']],
  [['  },', 'punc']],
  [['}', 'punc']],
]

const TONE: Record<Tok[1], string> = {
  key: 'text-foreground',
  str: 'text-brand',
  punc: 'text-muted-foreground/70',
  com: 'text-muted-foreground/55 italic',
}

export function SchemaCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border/70 bg-card shadow-2xl shadow-black/20 ring-1 ring-black/5',
        'dark:shadow-black/60 dark:ring-white/10',
        className,
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-border/50 bg-muted/40 px-3">
        <span className="font-mono text-[11px] text-muted-foreground">localbase.config.ts</span>
        <span className="rounded-sm border border-border/60 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          ts
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[11px] leading-[1.65]">
        <code>
          {CONFIG.map((line, i) => (
            <div key={i}>
              {line.map(([text, tone], j) => (
                <span key={j} className={TONE[tone]}>
                  {text}
                </span>
              ))}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}
