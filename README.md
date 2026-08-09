# speedtest

An internet speed test: a React client and a Cloudflare Worker backend.

```
speedtest/
├── client/          React + Vite front end
├── worker/          Cloudflare Worker backend (/ping /down /up /ip)
├── .env.example     copy to .env
└── package.json     npm workspaces — one install covers both
```

## Setup

```bash
npm install              # installs client and worker together
cp .env.example .env
npm run deploy:worker    # prints your Worker URL
```

Put that URL into `.env`:

```
VITE_SPEEDTEST_URL=https://speedtest-backend.<your-subdomain>.workers.dev
VITE_SPEEDTEST_BACKEND=worker
```

Then:

```bash
npm run dev              # http://localhost:5173
npm run build            # client/dist
```

Deploying the built site is a plain file copy — `client/dist` contains static
files only. Nothing server-side is needed, because the measurement backend is the
Worker.

If the app will live in a subfolder (`https://example.com/speedtest/`), set
`VITE_BASE=/speedtest/` before building.

### Deploying the Worker from WSL

`wrangler login` opens a browser on Windows while wrangler listens inside WSL, so
the OAuth callback never arrives. Use an API token instead:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token
2. Permissions: `Account · Workers Scripts · Edit`,
   `Account · Account Settings · Read`, `User · User Details · Read`
3. Then:

```bash
export CLOUDFLARE_API_TOKEN=your_token
npm run deploy:worker
```

## Why a Worker

A single server is close to some of your users and far from the rest, and distance
is the thing that dominates a speed test. The Worker deploys to every Cloudflare
city at once, so each user is measured against a nearby edge. The header shows
which one answered (`· edge KHI`).

What this measures is the connection to the nearest Cloudflare edge — which is the
right target for a speed test, since the question is how fast the user's line is,
not how far away your hosting is. Note that the edge you get depends on your ISP's
routing, not on Cloudflare: some ISPs hand traffic off far from home, and then the
latency stays high no matter how many locations Cloudflare has.

## How the measurement works

`client/src/lib/speedtest.js` has no React in it and can be reused anywhere.

- **Latency** — 12 probes over XHR, using Resource Timing where available. Ping is
  the *minimum*, since queueing only ever adds delay. Jitter is the mean absolute
  difference between consecutive probes.
- **Download** — parallel streams read through `fetch` + `ReadableStream` and
  discard the bytes, so memory stays flat. Streams start staggered to avoid an
  opening burst.
- **Upload** — a random blob is POSTed repeatedly. Progress events are counted as
  deltas (`e.loaded` is cumulative per request, and summing it inflates the result
  ~2.5x), and any shortfall is corrected when the request completes, because those
  events under-report on some cross-origin and HTTP/3 setups.
- **Warm-up** — the first few seconds of each phase are recorded but not counted.
  TCP slow start would otherwise drag the average down. The recorder draws that
  window hatched, so the graph shows what was excluded.
- **Adaptive length** — a phase runs `dlDuration`, then keeps going until the last
  3s agrees with the running average and enough bytes have moved, up to the max.
  Slow links get more time automatically, without a hardcoded speed threshold.
- **Self-correcting sizes** — if the backend won't start streaming a large chunk,
  the client halves it and retries. If uploads never finish inside the phase, the
  block shrinks. Neither failure shows up as a silent `0.00`.
- **Overhead** — results are multiplied by `overhead` (1.06) for TCP/IP framing,
  which JavaScript cannot see. Set it to `1` for payload-only throughput.

## Tuning

Everything is in `DEFAULTS` at the top of `client/src/lib/speedtest.js`.

| Setting | Default | Notes |
|---|---|---|
| `dlStreams` | 3 | more is not always faster — measure it |
| `ulStreams` | 2 | over HTTP/2 all streams share one connection, so few is better |
| `dlChunkMB` | 100 | per request; shrinks itself if the host buffers |
| `ulBlobMB` | 2 | shrinks itself on 413 or if nothing completes |
| `rampUp` | 4000 | excluded from the result |
| `dlDuration` / `ulDuration` | 12000 | minimum phase length |
| `dlMaxDuration` / `ulMaxDuration` | 32000 | ceiling for adaptive extension |
| `overhead` | 1.06 | set to 1 to disable |

**Check endpoints**, at the bottom of the page, is the tool for tuning. It reports
the negotiated HTTP protocol, each endpoint's status and single-stream speed, a
ladder of chunk sizes with time-to-first-byte, and aggregate throughput at 1, 3 and
6 parallel streams — plus the same for uploads. Use it to pick `dlStreams` and
`ulStreams` rather than copying numbers.

One caveat about it: the probes saturate the link, so on a connection with
bufferbloat each probe partly measures the congestion the previous one left behind.
There is a settle gap between probes, but treat the probe figures as a direction
and the actual run as the result.

## Using LibreSpeed's PHP backend instead

The client still supports it — set `VITE_SPEEDTEST_BACKEND=librespeed` and point
`VITE_SPEEDTEST_URL` at the folder holding `empty.php`, `garbage.php` and
`getIP.php`. No PHP files ship here. Two things to know if you go that route:

- `garbage.php` must actually stream. `ini_set('output_buffering','Off')` cannot
  close a buffer PHP has already opened, so on shared hosting a large `ckSize` is
  held in memory until it's complete — the client then sees no first byte and reads
  `0.00`. Close the open buffer with `ob_end_clean()` and send no `Content-Length`.
- `empty.php` must not read the request body. The web server discards it, and
  draining `php://input` in PHP is extremely slow on LiteSpeed — a 2MB POST went
  from ~2s to ~20s in testing, which collapsed the measured upload.
