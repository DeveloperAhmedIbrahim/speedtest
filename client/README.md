# Speedtest

React client for a LibreSpeed PHP backend. Keep the backend you already have —
`empty.php`, `garbage.php`, `getIP.php` are all still used, unchanged.

---

## 1. What was making the numbers wrong

| Problem in the old client | Effect | Fix |
|---|---|---|
| Download used **one** connection | A single TCP stream can't fill a link. Reported ~40–60% of the real speed. | 6 parallel streams, started 250ms apart |
| Averaged the whole 10s, including TCP slow start | Under-reported again | First 2.5s of each phase is recorded but **not counted** |
| Upload summed `e.loaded` on every progress event | `e.loaded` is cumulative per request. 512KB sent across 4 events counted as 1.28MB — upload was inflated roughly **2.5×** | Counts the delta between events |
| 512KB upload chunks, one at a time | Per-request overhead dominated | 8MB random blob, 3 parallel streams, reused |
| `Date.now()` around `fetch()` for ping, then averaged | ms resolution plus fetch scheduling noise | XHR + Resource Timing, **minimum** of 12 probes for ping, mean absolute difference for jitter |
| Gauge ticks placed by `tick/1000` while the max jumped between 10/50/100/… | Labels didn't match the arc | One shared non-linear scale (`SCALE` in `lib/speedtest.js`) used by both the dial and the graph |
| `garbage.php?ckSize=8` | Only 8MB of data — a fast link finished it in under a second | `ckSize=1024`, request aborted when the phase ends |
| Payload bytes only | ~6% low vs what your ISP advertises | `overhead: 1.06`, same factor LibreSpeed uses. Set it to `1` for raw payload throughput |

Everything lives in `src/lib/speedtest.js` — it has no React in it, so you can
reuse it anywhere.

---

## 2. Install

```bash
cd client
npm install
cp .env.example .env      # then edit it
npm run dev
```

`.env`:

```
VITE_SPEEDTEST_URL=/server                              # used by the browser
SPEEDTEST_PROXY_TARGET=https://speedtest.techrevivals.net   # dev proxy only
```

Leaving `VITE_SPEEDTEST_URL=/server` means the app talks to the PHP files that
sit next to it, which is what you want once it's deployed.

## 3. Deploy

```bash
npm run build
# copies index.html + assets/ next to the existing server/ folder
rsync -a --delete dist/ /var/www/html/speedtest/
```

If the app is served from `https://host/speedtest/` rather than the domain root,
set `VITE_BASE=/speedtest/` before building.

---

## 4. Server settings that decide your accuracy

These matter more than anything in the client.

**Never test against localhost.** A backend on the same machine measures the
loopback interface (thousands of Mbps), not your internet. The backend has to be
on the far side of the link you're measuring.

**nginx — upload will 413 out of the box.** Default `client_max_body_size` is
1MB and the client posts 8MB:

```nginx
location /speedtest/server/ {
    client_max_body_size 0;
    client_body_buffer_size 128k;
    gzip off;
    fastcgi_buffering off;
    fastcgi_read_timeout 120s;
    include fastcgi_params;
    fastcgi_pass unix:/run/php/php8.3-fpm.sock;
}
```

**Apache:**

```apache
<Directory /var/www/html/speedtest/server>
    LimitRequestBody 0
    SetEnv no-gzip 1
</Directory>
```

**PHP-FPM needs enough workers.** Six download streams hold six workers for the
whole phase. If `pm.max_children` is 5, streams queue and the result is garbage.
Give it at least 12.

```ini
; php.ini
memory_limit = 128M
max_execution_time = 60
post_max_size = 0
```

**Prefer HTTP/1.1 for the speedtest vhost.** Over HTTP/2 the browser multiplexes
all six streams onto a *single* TCP connection, which is exactly the bottleneck
the parallel streams exist to avoid. If you must keep h2, expect lower download
numbers on long-latency or lossy paths.

**Sharper ping (optional).** Add one line to `server/empty.php` so the browser
exposes precise Resource Timing to a cross-origin client:

```php
header('Timing-Allow-Origin: *');
```

**Less CPU on the server (optional).** `garbage.php` generates random bytes on
every request. A static file is cheaper and faster:

```bash
head -c 1G /dev/urandom > /var/www/html/speedtest/random.dat
```

Then set `dlStaticUrl: '/speedtest/random.dat'` in `CONFIG` (`src/App.jsx`) and
make sure the web server sends `Cache-Control: no-store` and no gzip for it.

---

## 5. Tuning

All knobs are in `DEFAULTS` at the top of `src/lib/speedtest.js`:

- `dlStreams` / `ulStreams` — 6 is the browser's per-host HTTP/1.1 limit, so
  don't go higher unless you shard across hostnames.
- `dlDuration` / `ulDuration` — 11s each. Shorter is noisier.
- `rampUp` — how much of the start is thrown away. Raise it on high-latency
  links (satellite, long-haul mobile) where slow start takes longer.
- `overhead` — set to `1` if you want payload-only throughput.
- `ulBlobMB` — larger blobs on gigabit links, smaller on mobile.

## 6. Troubleshooting: download reads 0.00

Press **Check endpoints**. It climbs a ladder of chunk sizes and reports
time-to-first-byte for each, which is what actually distinguishes the two
possible failures:

```
OK    garbage.php?ckSize=4   first byte in 190ms, 4.0MB in 1234ms (~27.2 Mbps single stream)
FAIL  garbage.php?ckSize=32  no first byte within 5s — the host buffers this size
                             instead of streaming it. Set dlChunkMB below 32.
```

**Small sizes stream, large ones never send a first byte.** The host is holding
the whole response until PHP finishes generating it, so a big chunk never starts
arriving inside the phase window and the download reads 0.00. This is normal on
cPanel, LiteSpeed, and anything with a proxy in front.

The client now handles this on its own: if a request produces no headers within
`ttfbTimeout` (4s), it halves `dlChunk` for every stream and retries, down to
`dlChunkMinMB`. So the test degrades to a smaller chunk rather than reporting
zero. Use the ladder to find the largest size your host will stream and set
`dlChunkMB` to it — bigger chunks mean less per-request round-trip waste.

`server-patched/garbage.php` fixes the buffering at the source where you control
PHP: it closes the buffer that is already open (`ini_set` cannot), sends no
`Content-Length`, and writes 256KB blocks. On some shared hosts a proxy still
buffers regardless, which is why the client-side fallback exists too.

**`garbage.php?ckSize=4` → HTTP 500** means memory, not buffering: raise
`memory_limit` in cPanel's MultiPHP INI Editor.

**Everything OK but download is far below what a single stream can do.** The
check also probes 1, 2, 4 and 6 parallel streams and prints the aggregate for
each. On a real server the number climbs with the stream count. On a shared host
that queues PHP processes it goes *down*, and the last line tells you so:

```
1 parallel stream      22.9 Mbps aggregate
2 parallel streams     14.1 Mbps aggregate
6 parallel streams      6.4 Mbps aggregate
best concurrency       1 stream — extra streams do not help here, the server
                       queues them. Keep dlStreams low.
```

Set `dlStreams` in `src/lib/speedtest.js` to whatever that line recommends. This
is the one setting where the right value depends entirely on your backend, so
measure it rather than copying a number.

**`empty.php (POST)` → HTTP 413** means the body limit is below `ulBlobMB`. Raise
`post_max_size`, or lower `ulBlobMB`.

## 7. Your result will not equal Ookla's, and that is expected

Read the single-stream numbers the endpoint check gives you. On a shared cPanel
account roughly 230ms away, a realistic reading looks like:

```
empty.php (GET)          round trip 230ms
empty.php (POST 2MB)     ~3.1 Mbps single stream
garbage.php?ckSize=4     ~27.2 Mbps single stream
```

Those are ceilings imposed by the server and the distance, not by the client. At
230ms round trip a single TCP stream is limited by the receive window rather than
by your line, which is exactly why 3.1 Mbps single-stream upload shows up on a
line that Ookla measures at 11.5 Mbps.

Ookla picks the nearest server — for a Karachi connection that is a Cybernet box
a few ms away. Your backend is wherever your hosting is. Shared cPanel also
shares its uplink and CPU with other sites on the same box.

So the honest comparison is: your tool measures *your line to your server*, Ookla
measures *your line to the closest server it can find*. To get close to Ookla's
numbers you need the backend geographically near you — a small VPS in Karachi or
Lahore running the same `server/` folder will move the ping from ~228ms to single
digits and the throughput up with it. Keep the cPanel copy if you like; just
point `VITE_SPEEDTEST_URL` at whichever backend you want to measure against.

## 8. Known limits

Upload is measured from the browser's send progress, which reports bytes handed
to the OS socket buffer, not bytes the server has acknowledged. Over a full 8.5s
window that error is small, but it's why the upload trace is bumpier than the
download trace, and why the ramp-up window matters.
