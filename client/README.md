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

Press **Check endpoints** at the bottom of the page. It hits every endpoint and
prints the status code, so you get a name instead of a guess.

**`garbage.php?ckSize=50` → FAIL, HTTP 500 (but ckSize=4 is OK)**
PHP is buffering the whole response before sending it, so a large chunk blows
`memory_limit` and returns 500 with zero bytes. `ini_set('output_buffering','Off')`
in the stock file cannot fix this, because the buffer is already open by then.
Copy `server-patched/garbage.php` over `server/garbage.php` — it closes the open
buffer, drops `Content-Length`, and writes in 256KB blocks, so memory stays flat
at any size. On cPanel you can also raise `memory_limit` in MultiPHP INI Editor,
but the patched file is the real fix.

**`empty.php (POST)` → FAIL, HTTP 413**
The body limit is below `ulBlobMB`. Raise `post_max_size` (MultiPHP INI Editor on
cPanel) and `LimitRequestBody` / `client_max_body_size`, or lower `ulBlobMB` in
`src/lib/speedtest.js`. Default is now 2MB, which nearly every host accepts.

**Everything OK but the numbers are still low**
Look at the single-stream Mbps the check reports for `garbage.php`. That is your
ceiling for one connection to that particular server, and no client-side change
raises it.

## 7. Your result will not equal Ookla's, and that is expected

Ookla picks the nearest server — for a Karachi connection that is a Cybernet box
a few ms away. Your backend is wherever your hosting is. A ping of ~228ms means
the server is on another continent, and a shared cPanel account also shares its
uplink and CPU with other sites.

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
