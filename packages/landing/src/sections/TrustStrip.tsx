const readouts = [
  { key: 'Data', value: 'SQLite file, on your disk' },
  { key: 'Network', value: 'Loopback only' },
  { key: 'Telemetry', value: 'None' },
  { key: 'Licence', value: 'MIT' },
]

export function TrustStrip() {
  return (
    <section aria-label="How LocalBase handles your data" className="border-y border-border/40 bg-muted/15">
      <dl className="mx-auto grid w-full max-w-6xl grid-cols-2 px-4 sm:px-6 lg:grid-cols-4">
        {readouts.map(({ key, value }, index) => (
          <div
            key={key}
            className={
              'flex flex-col gap-1 py-5 sm:py-6 ' +
              (index > 0 ? 'lg:border-l lg:border-border/40 lg:pl-6 ' : '') +
              (index % 2 === 1 ? 'pl-4 ' : '')
            }
          >
            <dt className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {key}
            </dt>
            <dd className="text-sm">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
