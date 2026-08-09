import { useEffect, useRef, useState } from 'react';
import { SCALE, scaleFrac } from '../lib/speedtest';

function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rgba(hex, alpha) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * One continuous paper strip for the whole run: the blue pen draws download,
 * the red pen draws upload. The hatched band at the start of each phase is the
 * TCP warm-up — it is drawn, but it is not part of the final number.
 */
export default function Trace({ samples, rampUp, dlDuration, ulDuration }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [width, setWidth] = useState(680);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const height = width < 480 ? 130 : 168;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const c = {
      grid: token('--grid', '#cfd6c6'),
      rule: token('--rule', '#b3bca6'),
      ink: token('--ink', '#16211b'),
      ink2: token('--ink-2', '#4a554d'),
      dn: token('--pen-dn', '#12507a'),
      up: token('--pen-up', '#a32c1f'),
    };

    const padL = 30;
    const padR = 10;
    const padT = 10;
    const padB = 20;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const total = dlDuration + ulDuration;

    const x = (t) => padL + (t / total) * plotW;
    const y = (mbps) => padT + plotH - scaleFrac(mbps) * plotH;

    // ---- horizontal gridlines, labelled from the same scale as the dial
    ctx.font = "600 8.5px 'Chivo Mono', monospace";
    ctx.textBaseline = 'middle';
    SCALE.forEach((tick, i) => {
      const gy = padT + plotH - (i / (SCALE.length - 1)) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(width - padR, gy);
      ctx.strokeStyle = i === 0 ? c.rule : c.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      // label every other step — the gridlines stay, the labels stay readable
      if (i === 0 || i % 2 === 1) {
        ctx.fillStyle = c.ink2;
        ctx.textAlign = 'right';
        ctx.fillText(tick >= 1000 ? '1K' : String(tick), padL - 5, gy);
      }
    });

    // ---- time ticks every 2s
    ctx.textAlign = 'center';
    for (let t = 0; t <= total; t += 2000) {
      const gx = x(t);
      ctx.beginPath();
      ctx.moveTo(gx, padT);
      ctx.lineTo(gx, padT + plotH);
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // ---- warm-up bands (hatched = recorded but not counted)
    const hatch = (from, to) => {
      const x0 = x(from);
      const x1 = x(to);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, padT, x1 - x0, plotH);
      ctx.clip();
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      for (let d = -plotH; d < x1 - x0 + plotH; d += 6) {
        ctx.beginPath();
        ctx.moveTo(x0 + d, padT + plotH);
        ctx.lineTo(x0 + d + plotH, padT);
        ctx.stroke();
      }
      ctx.restore();
    };
    const hasDl = samples.some((s) => s.phase === 'download');
    const hasUl = samples.some((s) => s.phase === 'upload');
    if (hasDl) hatch(0, rampUp);
    if (hasUl) hatch(dlDuration, dlDuration + rampUp);

    // ---- phase divider + silkscreen labels
    ctx.beginPath();
    ctx.moveTo(x(dlDuration), padT);
    ctx.lineTo(x(dlDuration), padT + plotH);
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = "600 8.5px 'Chivo Mono', monospace";
    ctx.fillStyle = c.ink2;
    ctx.textAlign = 'left';
    ctx.fillText('DOWNLOAD', x(0) + 4, height - padB + 10);
    ctx.fillText('UPLOAD', x(dlDuration) + 4, height - padB + 10);

    // ---- pens
    const drawPen = (phase, color, offset) => {
      const pts = samples
        .filter((s) => s.phase === phase)
        .map((s) => ({ px: x(offset + Math.min(s.t, phase === 'download' ? dlDuration : ulDuration)), py: y(s.mbps) }));
      if (pts.length < 2) return pts;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].px, padT + plotH);
      pts.forEach((p) => ctx.lineTo(p.px, p.py));
      ctx.lineTo(pts[pts.length - 1].px, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = rgba(color, 0.13);
      ctx.fill();

      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.px, p.py) : ctx.moveTo(p.px, p.py)));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      return pts;
    };

    const dlPts = drawPen('download', c.dn, 0);
    const ulPts = drawPen('upload', c.up, dlDuration);

    // ---- pen head on whichever phase is still writing
    const head = ulPts.length ? { p: ulPts[ulPts.length - 1], color: c.up }
      : dlPts.length ? { p: dlPts[dlPts.length - 1], color: c.dn }
        : null;
    if (head) {
      ctx.beginPath();
      ctx.arc(head.p.px, head.p.py, 3, 0, Math.PI * 2);
      ctx.fillStyle = head.color;
      ctx.fill();
    }

    // ---- frame
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [samples, width, rampUp, dlDuration, ulDuration]);

  return (
    <div className="trace">
      <div className="trace__head">
        <span className="tag">Recorder</span>
        <div className="trace__pens">
          <span className="pen" style={{ '--pen': 'var(--pen-dn)' }}>Download</span>
          <span className="pen" style={{ '--pen': 'var(--pen-up)' }}>Upload</span>
          <span className="pen" style={{ '--pen': 'var(--grid)' }}>Warm-up · not counted</span>
        </div>
      </div>
      <div ref={wrapRef}>
        <canvas ref={canvasRef} className="trace__canvas" />
      </div>
    </div>
  );
}
