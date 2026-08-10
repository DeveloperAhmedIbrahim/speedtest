/**
 * speedtest.js — measurement engine
 *
 * Works against a LibreSpeed PHP backend (empty.php / garbage.php / getIP.php).
 *
 * Why the old numbers were wrong:
 *  1. Download used ONE connection. A single TCP stream cannot saturate a link
 *     (window scaling + loss recovery cap it), so you read ~30-60% of the truth.
 *  2. Download averaged over the whole 10s window, including TCP slow start.
 *  3. Upload summed `e.loaded` on every progress event. `e.loaded` is CUMULATIVE
 *     per request, so 512KB sent in 4 events counted as 1.28MB — upload was
 *     inflated ~2.5x. Fixed here by counting deltas.
 *  4. Ping averaged 10 fetch() round trips with Date.now() (ms resolution, and
 *     fetch adds scheduling overhead). Now: Resource Timing when available,
 *     min-of-samples for ping, mean |delta| for jitter.
 */

export const DEFAULTS = {
  // 'librespeed' → empty.php / garbage.php / getIP.php
  // 'worker'     → /ping /down /up /ip  (the Cloudflare Worker in ../worker)
  backend: 'librespeed',

  // Base URL of the backend. Relative is fine for librespeed.
  baseUrl: '/server',

  // Optional: spread streams across several origins, e.g.
  //   ['https://st1.example.net/server', 'https://st2.example.net/server']
  // Over HTTP/2 the browser multiplexes every request to one origin onto a
  // SINGLE TCP connection, so parallel streams stop helping. Separate hostnames
  // force separate connections and restore the benefit. Empty = use baseUrl.
  hosts: [],

  // Optional: serve download bytes from a static file instead of garbage.php
  // (faster + far less CPU on the server). e.g. '/random.dat'
  dlStaticUrl: null,

  pingCount: 12,
  pingTimeout: 5000,

  dlStreams: 3,
  // Upload deliberately runs FEW streams. Over HTTP/2 or HTTP/3 every stream
  // shares one connection, so extra streams do not add capacity — they just
  // split it, and at high latency nothing finishes inside the phase window.
  // A single stream already reaches the link's upload ceiling.
  ulStreams: 2,

  // Base length of each phase. A phase runs at least this long, then keeps
  // going until the reading settles — up to the max. Slow links need more time:
  // the same wobble matters more when fewer bytes have moved, and TCP ramp-up
  // eats a bigger share of a slow phase.
  dlDuration: 12000,
  ulDuration: 12000,
  dlMaxDuration: 32000,
  ulMaxDuration: 32000,

  // A phase may stop once BOTH are true:
  //  - the last 3s agrees with the running average within this tolerance
  //  - at least this many bytes landed in the counted window
  // The byte floor is what makes slow links run longer automatically: 8MB takes
  // 8s at 8 Mbps but under a second at 100 Mbps.
  stableTolerance: 0.12,
  minCountedBytes: 8 * 1048576,
  extendStep: 2000,

  // Slow-start window that is measured but NOT counted in the final number.
  // On a high-latency server the streams need longer before they settle, and on
  // a host that queues PHP processes this is also the queue draining.
  rampUp: 4000,

  // Start streams one by one instead of all at once (avoids an initial burst
  // that distorts the first samples).
  streamStagger: 250,

  // garbage.php ckSize in MB, per request. Streams loop, so this is not the
  // total — it only sets how much each request asks for.
  // Many hosts (LiteSpeed, cPanel, anything with forced output buffering or a
  // proxy in front) hold a large response until it is fully generated, so the
  // first byte never arrives and the phase reads 0.00. The client detects that
  // and halves the chunk automatically, down to dlChunkMinMB.
  dlChunkMB: 100,
  dlChunkMinMB: 2,

  // If no headers come back within this long, the chunk is too big for the host.
  ttfbTimeout: 4000,

  // Size of the random blob POSTed per upload request. Must stay under PHP's
  // post_max_size and the web server's body limit — if a POST comes back 413 the
  // client halves this automatically, down to ulBlobMinMB.
  // Small enough that requests complete often, which keeps the measurement
  // granular and limits how much is lost when the phase ends mid-request.
  ulBlobMB: 2,
  ulBlobMinMB: 1,

  // TCP/IP/Ethernet framing is not visible to JS. We only count HTTP payload
  // bytes, so the wire rate is ~6% higher. Same factor LibreSpeed uses.
  // Set to 1 if you want raw payload throughput.
  overhead: 1.06,

  sampleInterval: 100,   // how often we push a sample for the graph
  instWindow: 800,       // sliding window used for the live reading
};

const abs = (u) => new URL(u, window.location.href).href;
const rnd = () => Math.random().toString(36).slice(2);
const toMbps = (bytes, seconds, overhead) =>
  seconds > 0 ? (bytes * 8 * overhead) / seconds / 1e6 : 0;

/* ------------------------------------------------------------------ *
 * Meter — cumulative byte counter with a timeline of snapshots.
 * Any window can then be answered as a difference of two snapshots.
 * ------------------------------------------------------------------ */
class Meter {
  constructor(overhead) {
    this.overhead = overhead;
    this.bytes = 0;
    this.t0 = performance.now();
    this.marks = [{ t: 0, bytes: 0 }];
  }

  add(n) {
    if (n > 0) this.bytes += n;
  }

  tick() {
    this.marks.push({ t: performance.now() - this.t0, bytes: this.bytes });
    return this.marks[this.marks.length - 1];
  }

  /** Speed over the last `ms`, for the live readout. */
  instant(ms) {
    const last = this.marks[this.marks.length - 1];
    const cutoff = last.t - ms;
    let ref = this.marks[0];
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.marks[i].t <= cutoff) { ref = this.marks[i]; break; }
    }
    return toMbps(last.bytes - ref.bytes, (last.t - ref.t) / 1000, this.overhead);
  }

  /** Bytes that landed after the ramp-up window. */
  countedBytes(rampUp) {
    const last = this.marks[this.marks.length - 1];
    if (last.t <= rampUp) return 0;
    let ref = this.marks[0];
    for (const m of this.marks) {
      if (m.t >= rampUp) { ref = m; break; }
    }
    return last.bytes - ref.bytes;
  }

  /** Whole-phase rate, ignoring the ramp-up split. */
  overall() {
    const last = this.marks[this.marks.length - 1];
    return toMbps(last.bytes, last.t / 1000, this.overhead);
  }

  /** Final number: everything after the ramp-up window. */
  measured(rampUp) {
    const last = this.marks[this.marks.length - 1];
    if (last.t <= rampUp + 500) {
      // Phase was too short to skip the ramp — use the whole thing.
      return toMbps(last.bytes, last.t / 1000, this.overhead);
    }
    let ref = this.marks[0];
    for (const m of this.marks) {
      if (m.t >= rampUp) { ref = m; break; }
    }
    return toMbps(last.bytes - ref.bytes, (last.t - ref.t) / 1000, this.overhead);
  }
}

/* ------------------------------------------------------------------ */

export class SpeedTest {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.stopped = false;
    this.controllers = [];
    this.xhrs = [];
    this.lastError = null;
    // Mutable: both shrink themselves if the host rejects the size.
    this.dlChunk = this.cfg.dlChunkMB;
    this.ulBlobMB = this.cfg.ulBlobMB;
    this.ulBlob = null;
    this.ulStats = { completed: 0, failed: 0, lastStatus: null };
    this.ulResized = false;
  }

  /** Endpoint filename for the configured backend. */
  endpoint(kind) {
    const worker = this.cfg.backend === 'worker';
    return {
      ping: worker ? 'ping' : 'empty.php',
      upload: worker ? 'up' : 'empty.php',
      download: worker ? 'down' : 'garbage.php',
      info: worker ? 'ip' : 'getIP.php',
    }[kind];
  }

  url(file, params = {}, streamIndex = 0) {
    const pool = this.cfg.hosts?.length ? this.cfg.hosts : [this.cfg.baseUrl];
    const base = pool[streamIndex % pool.length].replace(/\/+$/, '');
    const q = new URLSearchParams({ cors: 'true', r: rnd(), ...params });
    return `${base}/${file}?${q}`;
  }

  abort() {
    this.stopped = true;
    for (const c of this.controllers) { try { c.abort(); } catch { /* noop */ } }
    for (const x of this.xhrs) { try { x.abort(); } catch { /* noop */ } }
    this.controllers = [];
    this.xhrs = [];
  }

  /* ---------------- connection info ---------------- */

  infoUrl() {
    return this.cfg.backend === 'worker'
      ? this.url('ip')
      : this.url('getIP.php', { isp: 'true' });
  }

  async getInfo() {
    try {
      const res = await fetch(this.infoUrl(), { cache: 'no-store' });
      const data = await res.json();
      return typeof data === 'string' ? { processedString: data } : data;
    } catch {
      return null;
    }
  }

  /* ---------------- endpoint self-check ---------------- */

  /**
   * Hits each endpoint and reports what actually came back. This is the thing
   * to run when a phase reads 0.00 — it names the failing request and its
   * status code instead of leaving you guessing.
   */
  async diagnose() {
    const out = [];
    const line = (name, ok, detail) => out.push({ name, ok, detail });
    const PING = this.endpoint('ping');
    const DOWN = this.endpoint('download');
    const UP = this.endpoint('upload');
    const INFO = this.endpoint('info');
    const sizeParam = (mb) => (this.cfg.backend === 'worker'
      ? { bytes: String(mb * 1048576) }
      : { ckSize: String(mb) });
    const sizeLabel = (mb) => `${DOWN} @ ${mb}MB`;

    // 0. Which HTTP version did we get? Over h2/h3 every request to one origin
    //    shares a single TCP connection, so parallel streams stop scaling and a
    //    high-latency link stays window-limited no matter how many you open.
    try {
      const u = this.url(PING);
      await fetch(u, { cache: 'no-store' });
      const entry = performance.getEntriesByName(abs(u)).pop();
      const proto = entry?.nextHopProtocol || 'unknown';
      const multiplexed = proto === 'h2' || proto === 'h3';
      line('http protocol', !multiplexed, multiplexed
        ? `${proto} — every stream shares ONE TCP connection, so extra streams barely help. `
          + 'Serve this vhost over HTTP/1.1, or set `hosts` to several subdomains.'
        : proto);
    } catch {
      line('http protocol', false, 'could not be determined');
    }

    // 1. connection info
    try {
      const t = performance.now();
      const res = await fetch(this.infoUrl(), { cache: 'no-store' });
      line(INFO, res.ok, `HTTP ${res.status} in ${Math.round(performance.now() - t)}ms`);
    } catch (e) {
      line(INFO, false, e?.message || 'request failed');
    }

    // 2. the latency endpoint
    try {
      const t = performance.now();
      const res = await fetch(this.url(PING), { cache: 'no-store' });
      line(`${PING} (GET)`, res.ok, `HTTP ${res.status}, round trip ${Math.round(performance.now() - t)}ms`);
    } catch (e) {
      line(`${PING} (GET)`, false, e?.message || 'request failed');
    }

    // 3. the upload path, at the size the test actually uses
    try {
      const blob = this.makeBlob();  // uses the current ulBlobMB
      const t = performance.now();
      const res = await fetch(this.url(UP), {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ms = performance.now() - t;
      const mbps = (this.ulBlobMB * 1048576 * 8) / (ms / 1000) / 1e6;
      line(
        `${UP} (POST ${this.ulBlobMB}MB)`,
        res.ok,
        res.ok
          ? `HTTP ${res.status} in ${Math.round(ms)}ms (~${mbps.toFixed(1)} Mbps single stream)`
          : `HTTP ${res.status} — body limit is below ${this.ulBlobMB}MB (post_max_size / client_max_body_size / LimitRequestBody)`,
      );
    } catch (e) {
      line(`${UP} (POST)`, false, e?.message || 'request failed');
    }

    // 4. climb the ladder until the host stops streaming, so you
    //    can see exactly how large a chunk it will actually ship.
    for (const mb of [4, 8, 16, 32, 64]) {
      const controller = new AbortController();
      let ttfbExpired = false;
      const ttfb = setTimeout(() => { ttfbExpired = true; controller.abort(); }, 5000);
      const hardStop = setTimeout(() => controller.abort(), 9000);
      let firstByteAt = null;
      try {
        const t = performance.now();
        const res = await fetch(this.url(DOWN, sizeParam(mb)), {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(ttfb);
        if (!res.ok) {
          line(sizeLabel(mb), false, `HTTP ${res.status}`);
          break;
        }
        const reader = res.body.getReader();
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstByteAt === null) firstByteAt = performance.now() - t;
          bytes += value.byteLength;
          if (performance.now() - t > 4000) {
            try { await reader.cancel(); } catch { /* noop */ }
            break;
          }
        }
        const ms = performance.now() - t;
        line(sizeLabel(mb), bytes > 0,
          `first byte in ${Math.round(firstByteAt ?? ms)}ms, `
          + `${(bytes / 1048576).toFixed(1)}MB in ${Math.round(ms)}ms `
          + `(~${((bytes * 8) / (ms / 1000) / 1e6).toFixed(1)} Mbps single stream)`);
      } catch (e) {
        clearTimeout(ttfb);
        const smallest = mb === 4;
        line(sizeLabel(mb), false, ttfbExpired
          ? (smallest
            // Even the smallest rung stalled. If ping and upload passed, the
            // server is fine and the path is dropping full-size packets — a
            // classic MTU / PMTUD blackhole, common on a fresh IPv6 route.
            ? 'no first byte within 5s, and this is the smallest size tested. If ping '
              + 'and upload passed above, the server is answering — something on the '
              + 'path is dropping full-size packets (MTU / PMTUD blackhole). Compare '
              + '`curl -4` against `curl -6` to the same URL, and try lowering the MTU '
              + 'or disabling IPv6 to confirm.'
            : 'no first byte within 5s — the host is buffering this size instead of '
              + `streaming it. Set dlChunkMB below ${mb}.`)
          : e?.message || 'request failed');
        break;
      } finally {
        clearTimeout(ttfb);
        clearTimeout(hardStop);
      }
    }

    // Probes saturate the link, so give it a moment to drain between runs —
    // otherwise each probe measures the congestion left by the previous one.
    const settle = () => new Promise((r) => setTimeout(r, 1200));

    // 5. How many parallel streams this server actually likes.
    const scores = [];
    for (const n of [1, 3, 6]) {
      await settle();
      try {
        const mbps = await this.probeConcurrency(n, 8000, 3500);
        scores.push({ n, mbps });
        line(`${n} parallel stream${n > 1 ? 's' : ''}`, true, `${mbps.toFixed(1)} Mbps aggregate`);
      } catch (e) {
        line(`${n} parallel streams`, false, e?.message || 'probe failed');
      }
    }
    if (scores.length > 1) {
      const best = scores.reduce((a, b) => (b.mbps > a.mbps ? b : a));
      const single = scores[0].mbps;
      line('best concurrency', true, best.mbps > single * 1.15
        ? `${best.n} streams (${best.mbps.toFixed(1)} Mbps) — set dlStreams to ${best.n}`
        : `${best.n} stream${best.n > 1 ? 's' : ''} — extra streams do not help here, `
          + 'the server queues them. Keep dlStreams low.');
    }

    // 6. Upload under real conditions — the single POST above says nothing
    //    about whether concurrent uploads survive for a whole phase.
    for (const n of [1, 2, 4]) {
      await settle();
      try {
        const r = await this.probeUpload(n, 10000, 4000);
        line(`upload, ${n} stream${n > 1 ? 's' : ''}`, r.completed > 0,
          `${r.mbps.toFixed(1)} Mbps after warm-up (${r.total.toFixed(1)} Mbps incl. warm-up) · `
          + `${r.completed} finished, ${r.failed} failed · status ${r.statuses}`);
      } catch (e) {
        line(`upload, ${n} streams`, false, e?.message || 'probe failed');
      }
    }

    return out;
  }

  /**
   * Reproduces the real upload phase: N concurrent POSTs for `ms`, reporting
   * aggregate throughput plus how many requests finished and how many failed.
   * This is what tells you whether the uploads are slow or simply dying.
   */
  async probeUpload(streams, ms, rampMs) {
    const meter = new Meter(this.cfg.overhead);
    const blob = this.makeBlob();
    const blobBytes = this.ulBlobMB * 1048576;
    const xhrs = [];
    const endsAt = performance.now() + ms;
    const stats = { completed: 0, failed: 0, statuses: new Set() };

    const one = () => {
      if (performance.now() >= endsAt) return;
      const xhr = new XMLHttpRequest();
      xhrs.push(xhr);
      let sent = 0;
      xhr.open('POST', this.url(this.endpoint('upload')), true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { meter.add(e.loaded - sent); sent = e.loaded; };
      xhr.onload = () => {
        stats.completed += 1;
        stats.statuses.add(xhr.status);
        if (xhr.status < 400 && blobBytes > sent) meter.add(blobBytes - sent);
        one();
      };
      xhr.onerror = () => { stats.failed += 1; setTimeout(one, 300); };
      xhr.send(blob);
    };

    for (let i = 0; i < streams; i++) setTimeout(one, i * 150);

    let rampBytes = 0;
    let rampAt = 0;
    const rampTimer = setTimeout(() => {
      rampBytes = meter.bytes;
      rampAt = performance.now();
    }, rampMs);

    await new Promise((r) => setTimeout(r, ms));
    clearTimeout(rampTimer);
    for (const x of xhrs) { try { x.abort(); } catch { /* noop */ } }

    const sec = rampAt ? (performance.now() - rampAt) / 1000 : ms / 1000;
    const bytes = rampAt ? meter.bytes - rampBytes : meter.bytes;
    return {
      mbps: (bytes * 8 * this.cfg.overhead) / sec / 1e6,
      total: (meter.bytes * 8 * this.cfg.overhead) / (ms / 1000) / 1e6,
      ...stats,
      statuses: [...stats.statuses].join(', ') || 'none',
    };
  }

  /**
   * Aggregate throughput with a given number of parallel streams.
   * On a proper server more streams means more speed. On a shared host that
   * queues PHP processes, more streams means LESS speed — this is how you find
   * out which one you have.
   */
  async probeConcurrency(streams, ms, rampMs) {
    const meter = new Meter(this.cfg.overhead);
    const ctrls = [];
    const endsAt = performance.now() + ms;

    const one = async () => {
      while (performance.now() < endsAt) {
        const c = new AbortController();
        ctrls.push(c);
        try {
          const res = await fetch(this.dlUrl(), {
            cache: 'no-store',
            signal: c.signal,
          });
          if (!res.ok || !res.body) return;
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            meter.add(value.byteLength);
            if (performance.now() >= endsAt) {
              try { await reader.cancel(); } catch { /* noop */ }
              return;
            }
          }
        } catch {
          return;
        }
      }
    };

    const jobs = [];
    for (let i = 0; i < streams; i++) jobs.push(one());

    // Same rule as the real test: skip the ramp, or the probe reads far too low
    // and tells you to use fewer streams than you should.
    let rampBytes = 0;
    let rampAt = 0;
    const rampTimer = setTimeout(() => {
      rampBytes = meter.bytes;
      rampAt = performance.now();
    }, rampMs);

    await new Promise((r) => setTimeout(r, ms));
    clearTimeout(rampTimer);
    for (const c of ctrls) { try { c.abort(); } catch { /* noop */ } }
    await Promise.allSettled(jobs);

    if (!rampAt) return 0;
    const sec = (performance.now() - rampAt) / 1000;
    return ((meter.bytes - rampBytes) * 8 * this.cfg.overhead) / sec / 1e6;
  }

  /* ---------------- ping / jitter ---------------- */

  measureOne() {
    return new Promise((resolve, reject) => {
      const url = this.url(this.endpoint('ping'));
      const full = abs(url);
      const xhr = new XMLHttpRequest();
      this.xhrs.push(xhr);

      let t0 = 0;
      let fallback = null;

      xhr.open('GET', url, true);
      xhr.timeout = this.cfg.pingTimeout;

      xhr.onreadystatechange = () => {
        // Headers received == first byte back from the server.
        if (xhr.readyState === 2 && fallback === null) {
          fallback = performance.now() - t0;
        }
      };
      xhr.onload = () => {
        // Resource Timing is more precise than JS timers when it's available.
        // Cross-origin needs `Timing-Allow-Origin: *` on the server.
        let precise = null;
        try {
          const entries = performance.getEntriesByName(full);
          const e = entries[entries.length - 1];
          if (e && e.responseStart > 0 && e.requestStart > 0) {
            precise = e.responseStart - e.requestStart;
          }
        } catch { /* noop */ }
        const v = precise ?? fallback ?? performance.now() - t0;
        resolve(Math.max(v, 0));
      };
      xhr.onerror = () => reject(new Error('ping failed'));
      xhr.ontimeout = () => reject(new Error('ping timed out'));

      t0 = performance.now();
      xhr.send();
    });
  }

  async runPing(onUpdate) {
    try { performance.clearResourceTimings(); } catch { /* noop */ }

    // Two throwaway requests so DNS / TCP / TLS setup is not measured.
    for (let i = 0; i < 2 && !this.stopped; i++) {
      try { await this.measureOne(); } catch { /* noop */ }
    }

    const samples = [];
    for (let i = 0; i < this.cfg.pingCount && !this.stopped; i++) {
      try {
        const v = await this.measureOne();
        samples.push(v);
        onUpdate?.({
          type: 'ping-progress',
          value: Math.min(...samples),
          progress: (i + 1) / this.cfg.pingCount,
        });
      } catch { /* a dropped probe is not fatal */ }
    }

    if (!samples.length) throw new Error('Server did not answer the latency probes.');

    // Lowest round trip is the honest latency; queueing only ever adds delay.
    const ping = Math.min(...samples);

    // Jitter: mean absolute difference between consecutive probes.
    let jitter = 0;
    if (samples.length > 1) {
      let sum = 0;
      for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
      jitter = sum / (samples.length - 1);
    }
    return { ping, jitter };
  }

  /* ---------------- download ---------------- */

  dlUrl(streamIndex = 0) {
    if (this.cfg.dlStaticUrl) {
      const sep = this.cfg.dlStaticUrl.includes('?') ? '&' : '?';
      return `${this.cfg.dlStaticUrl}${sep}r=${rnd()}`;
    }
    if (this.cfg.backend === 'worker') {
      return this.url('down', { bytes: String(this.dlChunk * 1048576) }, streamIndex);
    }
    return this.url('garbage.php', { ckSize: String(this.dlChunk) }, streamIndex);
  }

  async downloadStream(meter, deadline, streamIndex = 0) {
    while (!this.stopped && !deadline.done) {
      const askedFor = this.dlChunk;
      const controller = new AbortController();
      controller.ttfbExpired = false;
      this.controllers.push(controller);

      // If the host is buffering the whole response, headers never arrive.
      // Give up on this request and come back with a smaller chunk.
      const ttfbTimer = setTimeout(() => {
        controller.ttfbExpired = true;
        try { controller.abort(); } catch { /* noop */ }
      }, this.cfg.ttfbTimeout);

      try {
        const res = await fetch(this.dlUrl(streamIndex), {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(ttfbTimer);

        if (!res.ok) throw new Error(`${this.endpoint('download')} answered HTTP ${res.status}`);
        if (!res.body) throw new Error('This browser did not give a readable response body.');

        const reader = res.body.getReader();
        // Read and discard — nothing is buffered, so memory stays flat.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          meter.add(value.byteLength);
          if (this.stopped || deadline.done) {
            try { await reader.cancel(); } catch { /* noop */ }
            return;
          }
        }
      } catch (err) {
        clearTimeout(ttfbTimer);
        if (this.stopped) return;

        if (controller.ttfbExpired) {
          // Shrink for every stream, not just this one, then retry immediately.
          const next = Math.max(this.cfg.dlChunkMinMB, Math.floor(askedFor / 2));
          if (next < askedFor) {
            this.dlChunk = next;
            this.lastError = `${this.endpoint('download')} did not start sending ${askedFor}MB within `
              + `${(this.cfg.ttfbTimeout / 1000).toFixed(0)}s, so the chunk was reduced to ${next}MB. `
              + `The host is buffering the response instead of streaming it.`;
            continue;
          }
          this.lastError = `${this.endpoint('download')} did not start sending even ${askedFor}MB within `
            + `${(this.cfg.ttfbTimeout / 1000).toFixed(0)}s.`;
        } else if (err?.name === 'AbortError') {
          return;
        } else {
          this.lastError = err?.message || String(err);
        }

        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /* ---------------- upload ---------------- */

  makeBlob(sizeMB = this.ulBlobMB) {
    const CHUNK = 1048576;
    const chunk = new Uint8Array(CHUNK);
    // Random data so nothing along the path can compress it away.
    for (let i = 0; i < CHUNK; i += 65536) {
      crypto.getRandomValues(chunk.subarray(i, Math.min(i + 65536, CHUNK)));
    }
    const parts = new Array(sizeMB).fill(chunk);
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  uploadStream(meter, deadline, streamIndex = 0) {
    const blobBytes = this.ulBlobMB * 1048576;

    const send = () => {
      if (this.stopped || deadline.done) return;

      const xhr = new XMLHttpRequest();
      this.xhrs.push(xhr);
      let sent = 0;

      xhr.open('POST', this.url(this.endpoint('upload'), {}, streamIndex), true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      // THE FIX: e.loaded is cumulative for this request. Count the delta.
      xhr.upload.onprogress = (e) => {
        const delta = e.loaded - sent;
        sent = e.loaded;
        meter.add(delta);
      };

      xhr.onload = () => {
        this.ulStats.completed += 1;
        this.ulStats.lastStatus = xhr.status;
        if (xhr.status < 400) {
          // Progress events report bytes handed to the socket, and in some
          // setups (cross-origin, HTTP/3) they under-report or never fire at
          // all. The request finished, so the whole block did arrive — add
          // whatever the events missed.
          const missing = blobBytes - sent;
          if (missing > 0) meter.add(missing);
        }
        if (xhr.status === 413) {
          const next = Math.max(this.cfg.ulBlobMinMB, Math.floor(this.ulBlobMB / 2));
          if (next < this.ulBlobMB) {
            this.ulBlobMB = next;
            this.ulBlob = this.makeBlob(next);
            this.lastError = `${this.endpoint('upload')} returned 413, so the upload block was reduced `
              + `to ${next}MB. Raise post_max_size to use larger blocks.`;
          } else {
            this.lastError = `${this.endpoint('upload')} returned 413 even for ${this.ulBlobMB}MB.`;
          }
        } else if (xhr.status >= 400) {
          this.lastError = `${this.endpoint('upload')} rejected the upload with HTTP ${xhr.status}`;
        }
        send();
      };
      xhr.onerror = () => {
        this.ulStats.failed += 1;
        this.lastError = 'The upload request failed before it finished sending '
          + `(${this.ulStats.failed} failed, ${this.ulStats.completed} completed).`;
        if (!this.stopped) setTimeout(send, 300);
      };
      xhr.onabort = () => {
        // Two things abort an upload: the phase ending, and the block being
        // resized because it was too big for this link. Only the second one
        // should start a replacement request.
        if (this.ulResized && !this.stopped && !deadline.done) {
          setTimeout(send, 0);
        }
      };

      xhr.send(this.ulBlob);
    };
    send();
  }

  /* ---------------- phase driver ---------------- */

  async runPhase(phase, baseDuration, maxDuration, startStreams, onUpdate) {
    const cfg = this.cfg;
    const meter = new Meter(cfg.overhead);
    const startedAt = performance.now();

    // `at` is only for this loop's own extension decision. Streams watch `done`
    // instead: comparing against a moving timestamp let a stream exit at the old
    // deadline microseconds before the phase extended it, and the stream never
    // came back — the download flatlined while the phase kept running.
    const deadline = { at: startedAt + baseDuration, done: false };

    onUpdate?.({ type: 'phase', phase });

    const running = startStreams(meter, deadline);

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const mark = meter.tick();
        const inst = meter.instant(cfg.instWindow);

        onUpdate?.({
          type: 'sample',
          phase,
          t: mark.t,
          mbps: inst,
          counted: mark.t >= cfg.rampUp,
          progress: Math.min(mark.t / (deadline.at - startedAt), 1),
        });

        // On a very slow link a large block never finishes inside the phase, so
        // progress events stall against a full socket buffer and the reading
        // collapses to zero. Shrink the block and try again with smaller ones.
        if (
          phase === 'upload'
          && !this.stopped
          && mark.t > cfg.rampUp + 4000
          && this.ulStats.completed === 0
          && this.ulBlobMB > cfg.ulBlobMinMB
        ) {
          this.ulBlobMB = Math.max(cfg.ulBlobMinMB, Math.floor(this.ulBlobMB / 2));
          this.ulBlob = this.makeBlob(this.ulBlobMB);
          this.ulResized = true;
          onUpdate?.({
            type: 'phase-extended',
            phase,
            reason: `slow upload, block reduced to ${this.ulBlobMB}MB`,
          });
          for (const x of this.xhrs) { try { x.abort(); } catch { /* noop */ } }
          this.xhrs = [];
        }

        const reached = this.stopped || performance.now() >= deadline.at;

        if (reached && !this.stopped && mark.t < maxDuration) {
          // Decide whether the reading has settled, or whether this link simply
          // needs more time. Both conditions have to pass.
          const running_ = meter.measured(cfg.rampUp);
          const recent = meter.instant(3000);
          const spread = running_ > 0.01
            ? Math.abs(recent - running_) / running_
            : 1;
          const counted = meter.countedBytes(cfg.rampUp);
          const enoughBytes = counted >= cfg.minCountedBytes;
          // A jittery mobile link may never settle inside the tolerance. Once
          // plenty of data has moved, the average is trustworthy anyway.
          const plenty = counted >= cfg.minCountedBytes * 4;

          if (!plenty && (spread > cfg.stableTolerance || !enoughBytes)) {
            deadline.at = Math.min(
              startedAt + maxDuration,
              deadline.at + cfg.extendStep,
            );
            onUpdate?.({
              type: 'phase-extended',
              phase,
              until: (deadline.at - startedAt) / 1000,
              reason: !enoughBytes ? 'low throughput' : 'reading still moving',
            });
            return;
          }
        }

        if (reached) {
          deadline.done = true;
          clearInterval(timer);
          resolve();
        }
      }, cfg.sampleInterval);
    });

    this.abortPhase();
    try { await Promise.allSettled(running); } catch { /* noop */ }

    if (meter.bytes === 0 && !this.stopped) {
      onUpdate?.({
        type: 'phase-failed',
        phase,
        message: this.lastError
          || `No ${phase} data arrived. Run the endpoint check below to see which request is failing.`,
      });
      return 0;
    }

    let value = meter.measured(this.cfg.rampUp);

    // Traffic moved, but none of it landed in the counted window — reporting
    // 0.00 here would be a lie about the connection. Fall back to the whole
    // phase and say what happened.
    if (value === 0 && meter.bytes > 0 && !this.stopped) {
      value = meter.overall();
      const stats = phase === 'upload'
        ? ` ${this.ulStats.completed} requests finished, ${this.ulStats.failed} failed`
          + `${this.ulStats.lastStatus ? `, last status ${this.ulStats.lastStatus}` : ''}.`
        : '';
      onUpdate?.({
        type: 'phase-warning',
        phase,
        message: `${phase}: traffic stopped after the first `
          + `${(this.cfg.rampUp / 1000).toFixed(0)}s, so the counted window was empty. `
          + `Showing the whole-phase average instead.${stats}`
          + (this.lastError ? ` Last error: ${this.lastError}` : ''),
      });
    }

    return value;
  }

  abortPhase() {
    for (const c of this.controllers) { try { c.abort(); } catch { /* noop */ } }
    for (const x of this.xhrs) { try { x.abort(); } catch { /* noop */ } }
    this.controllers = [];
    this.xhrs = [];
  }

  /* ---------------- full run ---------------- */

  async run(onUpdate) {
    const cfg = this.cfg;
    const result = { ping: null, jitter: null, download: null, upload: null };

    onUpdate?.({ type: 'phase', phase: 'ping' });
    const { ping, jitter } = await this.runPing(onUpdate);
    result.ping = ping;
    result.jitter = jitter;
    onUpdate?.({ type: 'result', key: 'ping', value: ping });
    onUpdate?.({ type: 'result', key: 'jitter', value: jitter });
    if (this.stopped) return result;

    result.download = await this.runPhase(
      'download', cfg.dlDuration, cfg.dlMaxDuration,
      (meter, deadline) => {
        const jobs = [];
        for (let i = 0; i < cfg.dlStreams; i++) {
          jobs.push(
            new Promise((resolve) => setTimeout(resolve, i * cfg.streamStagger))
              .then(() => (this.stopped ? null : this.downloadStream(meter, deadline, i)))
          );
        }
        return jobs;
      },
      onUpdate,
    );
    onUpdate?.({ type: 'result', key: 'download', value: result.download });
    if (this.stopped) return result;

    this.ulBlob = this.makeBlob();
    result.upload = await this.runPhase(
      'upload', cfg.ulDuration, cfg.ulMaxDuration,
      (meter, deadline) => {
        for (let i = 0; i < cfg.ulStreams; i++) {
          setTimeout(() => {
            if (!this.stopped) this.uploadStream(meter, deadline, i);
          }, i * cfg.streamStagger);
        }
        return [];
      },
      onUpdate,
    );
    onUpdate?.({ type: 'result', key: 'upload', value: result.upload });

    onUpdate?.({ type: 'phase', phase: 'done' });
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * Shared non-linear scale. The gauge ticks and the graph gridlines both
 * read from this, so a label always sits where its value actually is.
 * ------------------------------------------------------------------ */
export const SCALE = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];

export function scaleFrac(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const n = SCALE.length - 1;
  if (v >= SCALE[n]) return 1;
  for (let i = 0; i < n; i++) {
    if (v <= SCALE[i + 1]) {
      const seg = (v - SCALE[i]) / (SCALE[i + 1] - SCALE[i]);
      return (i + seg) / n;
    }
  }
  return 1;
}

export function fmtSpeed(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function fmtMs(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}
