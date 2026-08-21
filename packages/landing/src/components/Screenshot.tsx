import { useState } from 'react'

import { ScreenshotLightbox } from '@/components/ScreenshotLightbox'
import { WindowFrame } from '@/components/WindowFrame'
import {
  SCREENSHOT_HEIGHT,
  SCREENSHOT_WIDTH,
  type Screenshot as ScreenshotMeta,
} from '@/config/screenshots'

type ScreenshotProps = {
  shot: ScreenshotMeta
  className?: string
  priority?: boolean
}

export function Screenshot({ shot, className, priority = false }: ScreenshotProps) {
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const title = `LocalBase — ${shot.label}`

  const frame = (
    <WindowFrame title={title} className={failed ? className : undefined}>
      {failed ? (
        <div className="flex size-full items-center justify-center bg-muted text-sm text-muted-foreground">
          Screenshot unavailable
        </div>
      ) : (
        <img
          src={shot.src}
          alt={shot.alt}
          width={SCREENSHOT_WIDTH}
          height={SCREENSHOT_HEIGHT}
          loading={priority ? 'eager' : 'lazy'}
          decoding={priority ? 'sync' : 'async'}
          onError={() => setFailed(true)}
          className="size-full object-cover object-left-top"
        />
      )}
    </WindowFrame>
  )

  if (failed) {
    return frame
  }

  return (
    <ScreenshotLightbox shot={shot} open={open} onOpenChange={setOpen} className={className}>
      {frame}
    </ScreenshotLightbox>
  )
}
