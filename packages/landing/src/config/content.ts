import {
  Database,
  FolderArchive,
  KeyRound,
  LayoutDashboard,
  Radio,
  RefreshCw,
  Shield,
  Terminal,
  Timer,
  Code2,
  type LucideIcon,
} from 'lucide-react'

import { screenshots, type ScreenshotId } from './screenshots'

export type FeatureRow = {
  id: ScreenshotId | 'sdk' | 'auth' | 'realtime'
  eyebrow: string
  title: string
  body: string
  bullets: string[]
  icon: LucideIcon
  showScreenshot?: boolean
}

export const featureRows: FeatureRow[] = [
  {
    id: 'studio',
    eyebrow: 'Admin Studio',
    title: 'Browse and edit data without writing a query',
    body: 'Admin Studio is served by the same process as the API. Open it with localbase studio, log in, and manage tables, users, Storage, and Jobs in the browser.',
    bullets: [
      'Table browser and inline row editing',
      'Schema inspector, users, and admin requests',
      'Storage and Jobs views in the same dashboard',
    ],
    icon: LayoutDashboard,
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
    icon: Database,
  },
  {
    id: 'sdk',
    eyebrow: 'TypeScript SDK',
    title: 'Query like you would against a hosted backend',
    body: 'The SDK is a Supabase-style builder over the generated REST API: select, insert, update, delete, filters, auth, realtime, and Storage from one client.',
    bullets: [
      'db.from("posts").select("*").eq("id", 1)',
      'Auth, realtime, and Storage on the same client',
      'Every call returns { data, error }',
    ],
    icon: Code2,
    showScreenshot: false,
  },
]

export const featureScreenshot = (id: ScreenshotId) => {
  const match = screenshots.find((item) => item.id === id)
  if (!match) throw new Error(`No screenshot registered for feature "${id}"`)
  return match
}

export type SecondaryFeature = {
  title: string
  body: string
  icon: LucideIcon
}

export const secondaryFeatures: SecondaryFeature[] = [
  {
    title: 'Optional auth',
    body: 'Email/password, Argon2id hashes, rotating refresh tokens, roles, and owner-scoped policies when you turn auth on.',
    icon: KeyRound,
  },
  {
    title: 'Realtime',
    body: 'WebSocket subscriptions and presence. With auth enabled, the handshake authenticates and owner policies apply, including replay.',
    icon: Radio,
  },
  {
    title: 'Local Storage',
    body: 'Private buckets on disk, signed URLs, and a Studio browser. Not a CDN — files live under .localbase/storage/.',
    icon: FolderArchive,
  },
  {
    title: 'Scheduled Jobs',
    body: 'Cron-driven TypeScript handlers with run history. One process, no distributed lock, overlapping runs of the same job are skipped.',
    icon: Timer,
  },
  {
    title: 'CLI that matches the docs',
    body: 'init, studio, migrate, backup/restore, auth users, admin promote/demote, and jobs — via npx @localbase/cli.',
    icon: Terminal,
  },
  {
    title: 'Hot reload',
    body: 'Schema changes reload the running server. Job handler edits still need a process restart — that limit is documented, not hidden.',
    icon: RefreshCw,
  },
  {
    title: 'Loopback by default',
    body: 'Binds 127.0.0.1:5180 unless you say otherwise. Non-loopback needs explicit bind, TLS, CORS, rate limits, and stable secrets.',
    icon: Shield,
  },
  {
    title: 'Manual backups',
    body: 'localbase db backup and db restore copy SQLite plus Storage with a checksum manifest. No automatic remote backups in this preview.',
    icon: Database,
  },
]

export type Step = {
  n: number
  title: string
  body: string
}

export const steps: Step[] = [
  {
    n: 1,
    title: 'Init',
    body: 'npx @localbase/cli init scaffolds the current directory: config, data dir, and nothing else to install.',
  },
  {
    n: 2,
    title: 'Define tables',
    body: 'Edit localbase.config.ts. Columns, types, and foreign keys are the schema. Save — migrations run on reload.',
  },
  {
    n: 3,
    title: 'Open Studio',
    body: 'npx @localbase/cli studio starts the API at localhost:5180 and opens Admin Studio so you can edit rows immediately.',
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
      'npx @localbase/cli init in an empty directory, then npx @localbase/cli studio. The binary name is localbase after you install @localbase/cli. There is no npm package named just localbase.',
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
      'In a local SQLite file and optional Storage directory under .localbase/ in the project. Back up with localbase db backup. Nothing is uploaded unless your own code does it.',
  },
]
