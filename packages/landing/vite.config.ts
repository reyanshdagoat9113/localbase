import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Standalone config: the root vite.config.ts is scoped to apps/renderer.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, '')
  const siteUrl = (process.env.VITE_SITE_URL || env.VITE_SITE_URL || 'https://localbase.reylabs.in')
    .replace(/\/$/, '')

  return {
    plugins: [
      react(),
      {
        name: 'absolute-seo-urls',
        transformIndexHtml(html) {
          return html
            .replace('href="/" id="canonical-link"', `href="${siteUrl}/" id="canonical-link"`)
            .replace('content="/" id="og-url"', `content="${siteUrl}/" id="og-url"`)
            .replace(
              'content="/og-image.png" id="og-image"',
              `content="${siteUrl}/og-image.png" id="og-image"`,
            )
            .replace(
              'content="/og-image.png" id="twitter-image"',
              `content="${siteUrl}/og-image.png" id="twitter-image"`,
            )
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5192,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: 5193,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
  }
})
