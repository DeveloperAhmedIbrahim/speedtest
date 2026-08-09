import { useEffect, useRef, useState } from 'react';
import { SCALE, scaleFrac } from '../lib/speedtest';

const START = Math.PI * 0.75;
const SWEEP = Math.PI * 1.5;

function token(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * value  — number shown in the middle (Mbps, or ms during the latency phase)
 * speed  — the value the needle points at (null while measuring latency)
 * pen    — CSS variable name for the active pen colour
 * phase  — 'idle' | 'ping' | 'download' | 'upload' | 'done'
 */
export default function Dial({ value, unit, speed, pen, phase, label, theme }) {
  const canvasRef = useRef(null);
  const animRef = useRef({ frac: 0, target: 0, raf: 0, sweep: 0 });
  const [size, setSize] = useState(300);

  useEffect(() => {
    const fit = () => setSize(Math.max(240, Math.min(320, window.innerWidth - 80)));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    animRef.current.target = speed === null || speed === undefined ? 0 : scaleFrac(speed);
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const colors = {
      grid: token('--grid', '#cfd6c6'),
      rule: token('--rule', '#b3bca6'),
      ink: token('--ink', '#16211b'),
      ink2: token('--ink-2', '#4a554d'),
      active: token(pen, '#12507a'),
    };

    const draw = () => {
      const a = animRef.current;
      // ease toward the target so the needle behaves like a physical one
      a.frac += (a.target - a.frac) * (reduced ? 1 : 0.14);
      a.sweep += reduced ? 0 : 0.045;

      const cx = size / 2;
      const cy = size / 2 + size * 0.045;
      const r = size * 0.375;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // track
      ctx.beginPath();
      ctx.arc(cx, cy, r, START, START + SWEEP);
      ctx.strokeStyle = colors.rule;
      ctx.lineWidth = 2;
      ctx.stroke();

      // ticks
      SCALE.forEach((tick, i) => {
        const ang = START + (i / (SCALE.length - 1)) * SWEEP;
        const len = 9;
        ctx.beginPath();
        ctx.moveTo(cx + (r - len) * Math.cos(ang), cy + (r - len) * Math.sin(ang));
        ctx.lineTo(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
        ctx.strokeStyle = colors.rule;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const lr = r + 13;
        ctx.fillStyle = colors.ink2;
        ctx.font = `600 ${Math.round(size * 0.034)}px 'Chivo Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tick >= 1000 ? '1K' : String(tick), cx + lr * Math.cos(ang), cy + lr * Math.sin(ang));
      });

      // minor ticks between the labelled ones
      for (let i = 0; i < SCALE.length - 1; i++) {
        for (let k = 1; k < 5; k++) {
          const ang = START + ((i + k / 5) / (SCALE.length - 1)) * SWEEP;
          ctx.beginPath();
          ctx.moveTo(cx + (r - 4) * Math.cos(ang), cy + (r - 4) * Math.sin(ang));
          ctx.lineTo(cx + r * Math.cos(ang), cy + r * Math.sin(ang));
          ctx.strokeStyle = colors.grid;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      if (phase === 'ping') {
        // no throughput to show yet — a slow sweep says "probing"
        const head = START + ((a.sweep % (Math.PI * 2)) / (Math.PI * 2)) * SWEEP;
        ctx.save();
        ctx.shadowColor = colors.active;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, r, head, head + 0.45);
        ctx.strokeStyle = colors.active;
        ctx.lineWidth = 6;
        ctx.lineCap = 'butt';
        ctx.stroke();
        ctx.restore();
      } else if (a.frac > 0.001) {
        ctx.save();
        ctx.shadowColor = colors.active;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx, cy, r, START, START + a.frac * SWEEP);
        ctx.strokeStyle = colors.active;
        ctx.lineWidth = 6;
        ctx.lineCap = 'butt';
        ctx.stroke();
        ctx.restore();

        // pointer: a short mark just inside the arc, so it never crosses the readout
        const ang = START + a.frac * SWEEP;
        ctx.beginPath();
        ctx.moveTo(cx + (r - 17) * Math.cos(ang), cy + (r - 17) * Math.sin(ang));
        ctx.lineTo(cx + (r - 6) * Math.cos(ang), cy + (r - 6) * Math.sin(ang));
        ctx.strokeStyle = colors.ink;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      a.raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animRef.current.raf);
  }, [size, pen, phase, theme]);

  return (
    <div className="dial">
      <div className="dial__stage" style={{ width: size, height: size }}>
        <canvas ref={canvasRef} className="dial__canvas" />
        <div className="dial__readout" aria-live="polite">
          <span className="dial__value">{value}</span>
          <span className="dial__unit" style={{ color: `var(${pen})` }}>{unit}</span>
          <span className="dial__phase">{label}</span>
        </div>
      </div>
    </div>
  );
}
