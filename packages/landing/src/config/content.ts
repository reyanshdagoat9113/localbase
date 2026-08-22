import { screenshots, type ScreenshotId } from './screenshots'

export type FeatureRow = {
  id: ScreenshotId | 'sdk' | 'auth' | 'realtime'
  eyebrow: string
  title: string
  body: string
  bullets: string[]
  showScreenshot?: boolean
}

export const featureRows: FeatureRow[] = [
  {
    id: 'studio',
    eyebrow: 'Admin Studio',
    title: 'Browse and edit data without writing a query',
    body: 'Admin Studio is served by the same process as the API. Open it with the studio command, log in, and manage tables, users, Storage, and Jobs in the browser.',
    bullets: [
      'Table browser and inline row editing',
      'Schema inspector, users, and admin requests',
      'Storage and Jobs views in the same dashboard',
    ],
    showScreenshot: false,
  },
  {
    id: 'table',
    eyebrow: 'Schema as config',
    title: 'A TypeScript file is the source of truth',
    body: 'Tables, columns, references, and optional auth live in localbase.config.ts. Save the file and the dev server hot-reloads. Migrations are generated and applied for you.',
    bullets: [
      'SQLite with auto-migrations from your schema',
      'Generated REST CRUD at localhost:5180',
      'Hot-reload when the config file changes',
    ],
  },
  {
    id: 'sdk',
    eyebrow: 'TypeScript SDK',
    title: 'Query like you would against a hosted backend',
    body: 'The SDK is a Supabase-style builder over the generated REST API: select, insert, update, delete, filters, auth, realtime, and Storage from one client.',
    bullets: [
      'Chainable queries — select, filter, insert, update, and delete',
      'Auth, realtime, and Storage on the same client',
      'Predictable responses: your data, or a typed error',
    ],
    showScreenshot: false,
  },
]

export const featureScreenshot = (id: ScreenshotId) => {
  const match = screenshots.find((item) => item.id === id)
  if (!match) throw new Error(`No screenshot registered for feature "${id}"`)
  return match
}

export type SecondaryFeature = {
  /** Short manifest key, rendered in mono. */
  key: string
  body: string
}

export const secondaryFeatures: SecondaryFeature[] = [
  {
    key: 'auth',
    body: 'Email/password, Argon2id hashes, rotating refresh tokens, roles, and owner-scoped policies when you turn auth on.',
  },
  {
    key: 'realtime',
    body: 'WebSocket subscriptions and presence. With auth enabled, the handshake authenticates and owner policies apply, including replay.',
  },
  {
    key: 'storage',
    body: 'Private buckets on disk, signed URLs, and a Studio browser. Not a CDN — files stay in a folder inside your project.',
  },
  {
    key: 'jobs',
    body: 'Cron-driven TypeScript handlers with run history. One process, no distributed lock; overlapping runs of the same job are skipped.',
  },
  {
    key: 'cli',
    body: 'Scaffold, migrate, back up and restore, manage users and roles, and inspect jobs — all from one CLI.',
  },
  {
    key: 'hot-reload',
    body: 'Schema changes reload the running server. Job handler edits still need a process restart — that limit is documented, not hidden.',
  },
  {
    key: 'network',
    body: 'Binds 127.0.0.1:5180 unless you say otherwise. Non-loopback needs explicit bind, TLS, CORS, rate limits, and stable secrets.',
  },
  {
    key: 'backup',
    body: 'localbase db backup and db restore copy SQLite plus Storage with a checksum manifest. No automatic remote backups in this preview.',
  },
]

export type Step = {
  n: number
  title: string
  result: string
  body: string
}

export const steps: Step[] = [
  {
    n: 1,
    title: 'Init',
    result: 'Project scaffolded',
    body: 'Creates the config file and data folder in the current directory — nothing else to install.',
  },
  {
    n: 2,
    title: 'Define tables',
    result: 'Migrations applied on save',
    body: 'Columns, types, and foreign keys in the schema file are the whole schema. Save it and the running server reloads.',
  },
  {
    n: 3,
    title: 'Open Studio',
    result: 'API and Studio at localhost:5180',
    body: 'Starts the API and opens Admin Studio so you can edit rows immediately.',
  },
]

export const nonGoals = [
  'A hosted multi-tenant backend',
  'PostgreSQL in this preview',
  'A Supabase replacement',
  'Automatic remote backups',
]

export type FaqItem = {
  question: string
  answer: string
}

export const faq: FaqItem[] = [
  {
    question: 'Is LocalBase production-ready?',
    answer:
      'No. This is a developer preview for local development, prototypes, and small internal tools. It is a single-process SQLite backend, not a multi-instance production platform.',
  },
  {
    question: 'Do I need Docker or a cloud account?',
    answer:
      'No. Install from npm, run on Node.js 22 or newer, and everything stays on your machine. There is no LocalBase cloud.',
  },
  {
    question: 'How do I install it?',
    answer:
      'Two commands do it — both shown in the Install section. The CLI package is @localbase/cli; there is no npm package named just localbase.',
  },
  {
    question: 'What about the other npm package named localbase?',
    answer:
      'An unrelated IndexedDB library already occupies the unscoped name localbase. This product is @localbase/cli, @localbase/sdk, @localbase/core, and @localbase/shared.',
  },
  {
    question: 'Will it replace PocketBase or Supabase?',
    answer:
      'No. PocketBase is a mature Go binary; Supabase is a hosted Postgres platform. LocalBase is the TypeScript, schema-as-config, local-dev workflow. Use those if you need production operations.',
  },
  {
    question: 'Where is my data stored?',
    answer:
      'In a local SQLite file inside your project, plus an optional storage folder for uploads. Back up with a single CLI command. Nothing is uploaded unless your own code does it.',
  },
]
