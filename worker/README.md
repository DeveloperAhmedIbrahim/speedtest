# worker

Stateless backend. Deploys to every Cloudflare city, so each user is measured
against their nearest edge.

Deploy from the repo root (`npm run deploy:worker`) — see the main README for the
WSL/API-token note.

| Route | Purpose |
|---|---|
| `GET /ping` | empty 200, used for latency and jitter |
| `GET /down?bytes=N` | N bytes of random data, streamed |
| `POST /up` | reads and discards the body |
| `GET /ip` | client IP, network, and which edge answered |

## Limits

One full test run is roughly 30–60 requests, so the free plan's daily request cap
is not the constraint for normal use. CPU is the one to watch: `/down` writes 256KB
at a time, so a very large `bytes` means many writes. If `npx wrangler tail` shows
CPU errors, lower `dlChunkMB` on the client or move to the paid plan. Check
Cloudflare's pricing page for current numbers rather than trusting a figure written
here.

Workers bandwidth is not metered, but this is a bandwidth-heavy use case — keep it
to your own tool rather than a public free-for-all.
