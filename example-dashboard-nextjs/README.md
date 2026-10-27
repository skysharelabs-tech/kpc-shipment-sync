# Example client dashboard (Next.js)

Next.js version of `../example-dashboard`: what the client's IT team builds on their side.

| File | Role |
|---|---|
| `app/api/webhooks/kpc/route.ts` | `POST` webhook from KPC: verify signature, save, reply 200 (also served at `/webhooks/kpc` via `next.config.ts`) |
| `app/api/live/route.ts` | Server-Sent Events stream that pushes changes to open browsers |
| `lib/kpc.ts` | SQLite store, duplicate/newer-only logic, Pull API first load + catch-up safety net |
| `instrumentation.ts` | Starts first load + catch-up (every 60 s) when the server boots |
| `app/page.tsx` | Dashboard screen (React, one `EventSource`, no polling) |

```bash
cp ../example-dashboard/.env .env.local   # KPC_WEBHOOK_SECRET, KPC_API_KEY, KPC_PULL_URL (drop PORT)
npm install
npm run build && npm start                # http://localhost:4545
```

Needs Node 22.13+ (`node:sqlite`) and a long-running server (`next start`, Docker, a VM). Serverless hosts
such as Vercel won't keep the SSE stream, the in-memory listeners, or the catch-up timer alive.
