/**
 * speedtest backend as a Cloudflare Worker.
 *
 * Deploys to every Cloudflare city at once, so a user in Karachi is measured
 * against the Karachi edge and a user in Dubai against the Dubai edge. That is
 * the only real fix for "my server is far from some of my users" — no library
 * makes distance go away.
 *
 * Endpoints (they mirror the LibreSpeed ones the client already knows):
 *   GET  /ping            → empty 200, for latency and jitter
 *   GET  /down?bytes=N    → N bytes of incompressible data, streamed
 *   POST /up              → reads and discards the body
 *   GET  /ip              → client IP, network, and which edge answered
 *
 * What this measures: your line to the nearest Cloudflare edge. For a speed test
 * that is the right thing — the user wants to know how fast their connection is,
 * not how far away your hosting happens to be.
 */

const CHUNK = 262144;          // 256KB per stream write
const MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_BYTES = 25 * 1024 * 1024;

// One block of random data, reused for every write. Random so that nothing along
// the path can compress it and flatter the result.
let BLOCK = null;
function block() {
  if (!BLOCK) {
    BLOCK = new Uint8Array(CHUNK);
    // crypto.getRandomValues caps at 65536 bytes per call.
    for (let i = 0; i < CHUNK; i += 65536) {
      crypto.getRandomValues(BLOCK.subarray(i, Math.min(i + 65536, CHUNK)));
    }
  }
  return BLOCK;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Content-Encoding',
  // Lets the browser read precise Resource Timing values cross-origin, which is
  // what makes the ping reading sharp rather than approximate.
  'timing-allow-origin': '*',
};

const noStore = {
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
};

function clampBytes(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BYTES;
  return Math.min(n, MAX_BYTES);
}

function downloadResponse(total) {
  const data = block();
  let sent = 0;

  const body = new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, total - sent);
      controller.enqueue(n === CHUNK ? data : data.subarray(0, n));
      sent += n;
    },
    cancel() {
      sent = total;
    },
  });

  return new Response(body, {
    headers: {
      ...cors,
      ...noStore,
      'content-type': 'application/octet-stream',
      'content-length': String(total),
      'content-disposition': 'attachment; filename=random.dat',
    },
  });
}

async function drain(request) {
  if (!request.body) return;
  const reader = request.body.getReader();
  // Read and throw away. Never buffer the whole upload.
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, ...noStore } });
    }

    if (path === '/up') {
      if (request.method !== 'POST') {
        return new Response('POST only', { status: 405, headers: cors });
      }
      await drain(request);
      return new Response(null, {
        status: 200,
        headers: { ...cors, ...noStore, 'content-length': '0' },
      });
    }

    if (path === '/down') {
      return downloadResponse(clampBytes(url.searchParams.get('bytes')));
    }

    if (path === '/ping') {
      return new Response(null, {
        status: 200,
        headers: { ...cors, ...noStore, 'content-length': '0' },
      });
    }

    if (path === '/ip') {
      const cf = request.cf || {};
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const where = [cf.city, cf.country].filter(Boolean).join(', ');
      const network = cf.asOrganization || (cf.asn ? `AS${cf.asn}` : '');
      const parts = [ip];
      if (network) parts.push(network);
      if (where) parts.push(where);
      const label = `${parts.join(' - ')}${cf.colo ? ` · edge ${cf.colo}` : ''}`;

      return new Response(JSON.stringify({
        processedString: label,
        ip,
        edge: cf.colo || null,
        city: cf.city || null,
        country: cf.country || null,
        network: network || null,
      }), {
        headers: { ...cors, ...noStore, 'content-type': 'application/json' },
      });
    }

    // Anything else: a tiny status page, handy for checking the deploy worked.
    return new Response(
      'speedtest worker is up. endpoints: /ping /down?bytes=N /up /ip\n',
      { status: 200, headers: { ...cors, ...noStore, 'content-type': 'text/plain' } },
    );
  },
};
