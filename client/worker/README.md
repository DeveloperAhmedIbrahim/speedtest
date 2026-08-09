# speedtest worker

Stateless backend for the speedtest client. Deploys to every Cloudflare city, so
each user is measured against their nearest edge.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy
```

You get a URL like `https://speedtest-backend.<your-subdomain>.workers.dev`.
Check it in a browser — it should print the endpoint list.

Then point the client at it (`client/.env`):

```
VITE_SPEEDTEST_BACKEND=worker
VITE_SPEEDTEST_URL=https://speedtest-backend.<your-subdomain>.workers.dev
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /ping` | empty 200, used for latency and jitter |
| `GET /down?bytes=N` | N bytes of random data, streamed |
| `POST /up` | reads and discards the body |
| `GET /ip` | client IP, network, and which edge answered |

## Limits worth knowing

The free plan has a daily request cap and a per-request CPU cap. One full test run
is roughly 30–60 requests, so the request cap is not the constraint for normal use.
CPU is the one to watch: the download route writes 256KB at a time, so a very large
`bytes` value means many writes. If you see CPU errors in `wrangler tail`, lower
`dlChunkMB` on the client or move to the paid plan. Current limits are on
Cloudflare's pricing page — check there rather than trusting a number written here.

Bandwidth on Workers is not metered, but this is a bandwidth-heavy use case. Keep
it to your own tool rather than a public free-for-all.
