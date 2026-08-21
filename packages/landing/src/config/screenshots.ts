export const SCREENSHOT_WIDTH = 1600
export const SCREENSHOT_HEIGHT = 1000

export type ScreenshotId = 'studio' | 'table'

export type Screenshot = {
  id: ScreenshotId
  src: string
  label: string
  alt: string
}

export const screenshots: Screenshot[] = [
  {
    id: 'studio',
    src: '/screenshots/studio.png',
    label: 'Admin Studio',
    alt: 'LocalBase Admin Studio table browser, listing user and system tables with row counts.',
  },
  {
    id: 'table',
    src: '/screenshots/table.png',
    label: 'Row editor',
    alt: 'LocalBase Admin Studio row grid for the projects table, with inline search and a new-row action.',
  },
]

export const heroScreenshot = screenshots[0]
