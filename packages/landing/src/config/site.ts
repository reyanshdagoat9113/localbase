export const GITHUB_OWNER = 'reyanshdagoat9113'
export const GITHUB_REPO = 'localbase'
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

/**
 * Canonical public origin for absolute SEO / OG URLs.
 * Set VITE_SITE_URL on the Railway service (https://localbase.reylabs.in).
 */
export const SITE_URL = (
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SITE_URL) ||
  'https://localbase.reylabs.in'
).replace(/\/$/, '')

/** Product version the page advertises. Keep in sync with public packages. */
export const APP_VERSION = '0.1.0-beta.2'

export const NPM_CLI = '@localbase/cli'
export const NPM_SDK = '@localbase/sdk'
export const NPM_CLI_URL = `https://www.npmjs.com/package/${NPM_CLI}`
export const NPM_SDK_URL = `https://www.npmjs.com/package/${NPM_SDK}`

export const INIT_COMMAND = `npx ${NPM_CLI} init`
export const STUDIO_COMMAND = `npx ${NPM_CLI} studio`

export const siteMeta = {
  name: 'LocalBase',
  tagline:
    'Define a schema and get a local SQLite backend with a REST API, TypeScript SDK, auth, realtime, Storage, scheduled Jobs, and an Admin Studio — without Docker or a cloud account.',
  trustLine: 'Local-first. SQLite. Runs on localhost. MIT licensed.',
  license: 'MIT',
  docsUrl: `${GITHUB_URL}/blob/dev/docs/GETTING-STARTED.md`,
  supportUrl: `${GITHUB_URL}/issues/new`,
  securityUrl: `${GITHUB_URL}/blob/dev/SECURITY.md`,
} as const
