# @localbase/landing

Public site for LocalBase. Static Vite app served by `server.mjs` so Railway can bind `PORT` on `0.0.0.0`.

```bash
npm run dev --workspace @localbase/landing
npm run build --workspace @localbase/landing
npm start --workspace @localbase/landing
```

Set `VITE_SITE_URL=https://localbase.reylabs.in` for canonical / OG URLs at build time.

Health check: `GET /healthz`.

## Railway

This package is self-contained so Railway can use **root directory** `packages/landing` (same pattern as DevDesk). Do not host the LocalBase runtime — only this static site.

1. New Railway **project** named LocalBase (preferred over a new environment on Devdesk — environments clone every service in that project).
2. Service from this folder: build `npm run build`, start `npm start`, health `/healthz`.
3. Variable: `VITE_SITE_URL=https://localbase.reylabs.in` (build-time; redeploy after setting).
4. Custom domain: `localbase.reylabs.in`.
5. Namecheap DNS for `reylabs.in`: CNAME host `localbase` → the record Railway prints (usually `*.up.railway.app` or `ghs.railway.app`).

`railway.json` already sets Railpack, health check, and restart policy.
