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
  // Base URL of the LibreSpeed `server` folder. Relative is fine.
  baseUrl: '/server',

  // Optional: serve download bytes from a static file instead of garbage.php
  // (faster + far less CPU on the server). e.g. '/random.dat'
  dlStaticUrl: null,

  pingCount: 12,
  pingTimeout: 5000,

  dlStreams: 6,
  ulStreams: 3,

  dlDuration: 11000,
  ulDuration: 11000,

  // Slow-start window that is measured but NOT counted in the final number.
  rampUp: 2500,

  // Start streams one by one instead of all at once (avoids an initial burst
  // that distorts the first samples).
  streamStagger: 250,

  // garbage.php ckSize in MB. Requests are aborted when the phase ends, and a
  // stream simply asks for the next chunk if it finishes early.
  // Keep this modest: if PHP output buffering is on, the whole response is held
  // in memory before the first byte ships, so 1024 blows memory_limit and you
  // get an instant 500 with zero bytes.
  dlChunkMB: 50,

  // Size of the random blob POSTed per upload request. Must stay under PHP's
  // post_max_size and the web server's body limit, or every POST is rejected.
  ulBlobMB: 2,

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
  }

  url(file, params = {}) {
    const base = this.cfg.baseUrl.replace(/\/+$/, '');
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

  async getInfo() {
    try {
      const res = await fetch(this.url('getIP.php', { isp: 'true' }), { cache: 'no-store' });
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

    // 1. getIP.php
    try {
      const t = performance.now();
      const res = await fetch(this.url('getIP.php', { isp: 'true' }), { cache: 'no-store' });
      line('getIP.php', res.ok, `HTTP ${res.status} in ${Math.round(performance.now() - t)}ms`);
    } catch (e) {
      line('getIP.php', false, e?.message || 'request failed');
    }

    // 2. empty.php, GET — this is the latency endpoint
    try {
      const t = performance.now();
      const res = await fetch(this.url('empty.php'), { cache: 'no-store' });
      line('empty.php (GET)', res.ok, `HTTP ${res.status}, round trip ${Math.round(performance.now() - t)}ms`);
    } catch (e) {
      line('empty.php (GET)', false, e?.message || 'request failed');
    }

    // 3. empty.php, POST — the upload path, at the size the test actually uses
    try {
      const blob = this.makeBlob();
      const t = performance.now();
      const res = await fetch(this.url('empty.php'), {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ms = performance.now() - t;
      const mbps = (this.cfg.ulBlobMB * 1048576 * 8) / (ms / 1000) / 1e6;
      line(
        `empty.php (POST ${this.cfg.ulBlobMB}MB)`,
        res.ok,
        res.ok
          ? `HTTP ${res.status} in ${Math.round(ms)}ms (~${mbps.toFixed(1)} Mbps single stream)`
          : `HTTP ${res.status} — body limit is below ${this.cfg.ulBlobMB}MB (post_max_size / client_max_body_size / LimitRequestBody)`,
      );
    } catch (e) {
      line('empty.php (POST)', false, e?.message || 'request failed');
    }

    // 4. garbage.php at the configured size
    for (const mb of [4, this.cfg.dlChunkMB]) {
      const controller = new AbortController();
      const stop = setTimeout(() => controller.abort(), 6000);
      try {
        const t = performance.now();
        const res = await fetch(this.url('garbage.php', { ckSize: String(mb) }), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          line(`garbage.php?ckSize=${mb}`, false,
            `HTTP ${res.status} — PHP is probably buffering the whole ${mb}MB and hitting memory_limit`);
        } else {
          const reader = res.body.getReader();
          let bytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (performance.now() - t > 3000) { await reader.cancel(); break; }
          }
          const ms = performance.now() - t;
          const ttfb = bytes > 0 ? '' : ' — headers came back but no body arrived';
          line(`garbage.php?ckSize=${mb}`, bytes > 0,
            `HTTP ${res.status}, ${(bytes / 1048576).toFixed(1)}MB in ${Math.round(ms)}ms `
            + `(~${((bytes * 8) / (ms / 1000) / 1e6).toFixed(1)} Mbps single stream)${ttfb}`);
        }
      } catch (e) {
        line(`garbage.php?ckSize=${mb}`, false, e?.name === 'AbortError'
          ? 'no response within 6s — the request is being generated or blocked before any bytes ship'
          : e?.message || 'request failed');
      } finally {
        clearTimeout(stop);
      }
    }

    return out;
  }

  /* ---------------- ping / jitter ---------------- */

  measureOne() {
    return new Promise((resolve, reject) => {
      const url = this.url('empty.php');
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

  dlUrl() {
    if (this.cfg.dlStaticUrl) {
      const sep = this.cfg.dlStaticUrl.includes('?') ? '&' : '?';
      return `${this.cfg.dlStaticUrl}${sep}r=${rnd()}`;
    }
    return this.url('garbage.php', { ckSize: String(this.cfg.dlChunkMB) });
  }

  async downloadStream(meter, endsAt) {
    const controller = new AbortController();
    this.controllers.push(controller);

    while (!this.stopped && performance.now() < endsAt) {
      try {
        const res = await fetch(this.dlUrl(), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`garbage.php answered HTTP ${res.status}`);
        if (!res.body) throw new Error('This browser did not give a readable response body.');

        const reader = res.body.getReader();
        // Read and discard — nothing is buffered, so memory stays flat.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          meter.add(value.byteLength);
          if (this.stopped || performance.now() >= endsAt) {
            try { await reader.cancel(); } catch { /* noop */ }
            return;
          }
        }
      } catch (err) {
        if (this.stopped || err?.name === 'AbortError') return;
        this.lastError = err?.message || String(err);
        // Transient failure: pause briefly instead of hammering the server.
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  /* ---------------- upload ---------------- */

  makeBlob() {
    const CHUNK = 1048576;
    const chunk = new Uint8Array(CHUNK);
    // Random data so nothing along the path can compress it away.
    for (let i = 0; i < CHUNK; i += 65536) {
      crypto.getRandomValues(chunk.subarray(i, Math.min(i + 65536, CHUNK)));
    }
    const parts = new Array(this.cfg.ulBlobMB).fill(chunk);
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  uploadStream(meter, endsAt, blob) {
    const send = () => {
      if (this.stopped || performance.now() >= endsAt) return;

      const xhr = new XMLHttpRequest();
      this.xhrs.push(xhr);
      let sent = 0;

      xhr.open('POST', this.url('empty.php'), true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      // THE FIX: e.loaded is cumulative for this request. Count the delta.
      xhr.upload.onprogress = (e) => {
        const delta = e.loaded - sent;
        sent = e.loaded;
        meter.add(delta);
      };

      xhr.onload = () => {
        if (xhr.status >= 400) {
          this.lastError = `empty.php rejected the upload with HTTP ${xhr.status}`
            + (xhr.status === 413 ? ' — the body limit is smaller than ulBlobMB' : '');
        }
        send();
      };
      xhr.onerror = () => {
        this.lastError = 'The upload request failed before it finished sending.';
        if (!this.stopped) setTimeout(send, 300);
      };
      xhr.onabort = () => { /* run is over */ };

      xhr.send(blob);
    };
    send();
  }

  /* ---------------- phase driver ---------------- */

  async runPhase(phase, duration, startStreams, onUpdate) {
    const meter = new Meter(this.cfg.overhead);
    const startedAt = performance.now();
    const endsAt = startedAt + duration;

    onUpdate?.({ type: 'phase', phase });

    const running = startStreams(meter, endsAt);

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const mark = meter.tick();
        const inst = meter.instant(this.cfg.instWindow);
        onUpdate?.({
          type: 'sample',
          phase,
          t: mark.t,
          mbps: inst,
          counted: mark.t >= this.cfg.rampUp,
          progress: Math.min(mark.t / duration, 1),
        });
        if (this.stopped || performance.now() >= endsAt) {
          clearInterval(timer);
          resolve();
        }
      }, this.cfg.sampleInterval);
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
    }

    return meter.measured(this.cfg.rampUp);
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

    result.download = await this.runPhase('download', cfg.dlDuration, (meter, endsAt) => {
      const jobs = [];
      for (let i = 0; i < cfg.dlStreams; i++) {
        jobs.push(
          new Promise((resolve) => setTimeout(resolve, i * cfg.streamStagger))
            .then(() => (this.stopped ? null : this.downloadStream(meter, endsAt)))
        );
      }
      return jobs;
    }, onUpdate);
    onUpdate?.({ type: 'result', key: 'download', value: result.download });
    if (this.stopped) return result;

    const blob = this.makeBlob();
    result.upload = await this.runPhase('upload', cfg.ulDuration, (meter, endsAt) => {
      for (let i = 0; i < cfg.ulStreams; i++) {
        setTimeout(() => {
          if (!this.stopped) this.uploadStream(meter, endsAt, blob);
        }, i * cfg.streamStagger);
      }
      return [];
    }, onUpdate);
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
