import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dial from './components/Dial';
import Trace from './components/Trace';
import Readouts from './components/Readouts';
import { DEFAULTS, SpeedTest, fmtMs, fmtSpeed } from './lib/speedtest';

const CONFIG = {
  ...DEFAULTS,

  // 'worker' → the Cloudflare Worker in ../worker
  // 'librespeed' → LibreSpeed's php endpoints, if you host them yourself
  backend: import.meta.env.VITE_SPEEDTEST_BACKEND || 'worker',

  // Deploy the worker, then put its URL in .env as VITE_SPEEDTEST_URL.
  baseUrl: import.meta.env.VITE_SPEEDTEST_URL || '',

  // Optional extra origins, comma separated. Only useful on a distant HTTP/2
  // backend, where one origin means one shared TCP connection.
  hosts: (import.meta.env.VITE_SPEEDTEST_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
};

const PENS = {
  idle: '--ink',
  ping: '--pen-ping',
  download: '--pen-dn',
  upload: '--pen-up',
  done: '--pen-dn',
};

const LABELS = {
  idle: 'Ready',
  ping: 'Measuring latency',
  download: 'Reading download',
  upload: 'Reading upload',
  done: 'Run complete',
};

const STEPS = [
  { key: 'ping', label: 'Latency', pen: '--pen-ping' },
  { key: 'download', label: 'Download', pen: '--pen-dn' },
  { key: 'upload', label: 'Upload', pen: '--pen-up' },
];

const ORDER = ['idle', 'ping', 'download', 'upload', 'done'];
const EMPTY = { ping: null, jitter: null, download: null, upload: null };

function readTheme() {
  try {
    const saved = localStorage.getItem('speedtest-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage may be blocked */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** What this connection is comfortably good for — plain language, no scores. */
function verdictFor(down, up, ping) {
  if (!Number.isFinite(down)) return null;
  const video = down >= 25 ? '4K streaming'
    : down >= 8 ? 'HD streaming'
      : down >= 3 ? 'SD streaming'
        : 'light browsing';
  const calls = Number.isFinite(up) && up >= 3 && Number.isFinite(ping) && ping < 150
    ? 'group video calls'
    : Number.isFinite(up) && up >= 1.5 ? 'one-to-one video calls' : 'voice calls';
  const gaming = Number.isFinite(ping)
    ? (ping < 50 ? 'competitive gaming' : ping < 120 ? 'casual gaming' : 'turn-based games')
    : null;
  return { video, calls, gaming };
}

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  const [phase, setPhase] = useState('idle');
  const [inst, setInst] = useState(0);
  const [livePing, setLivePing] = useState(null);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState(EMPTY);
  const [samples, setSamples] = useState([]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState([]);
  const [checks, setChecks] = useState(null);
  const [checking, setChecking] = useState(false);
  const [extending, setExtending] = useState(null);
  const [copied, setCopied] = useState(false);
  const [finishedAt, setFinishedAt] = useState(null);

  const testRef = useRef(null);
  const running = phase === 'ping' || phase === 'download' || phase === 'upload';
  const configured = Boolean(CONFIG.baseUrl);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('speedtest-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    if (!configured) return undefined;
    new SpeedTest(CONFIG).getInfo().then(setInfo);
    return () => testRef.current?.abort();
  }, [configured]);

  const start = useCallback(async () => {
    testRef.current?.abort();
    const test = new SpeedTest(CONFIG);
    testRef.current = test;

    setResults(EMPTY);
    setSamples([]);
    setInst(0);
    setProgress(0);
    setLivePing(null);
    setError(null);
    setFailures([]);
    setChecks(null);
    setCopied(false);
    setExtending(null);
    setFinishedAt(null);
    setPhase('ping');

    try {
      await test.run((ev) => {
        switch (ev.type) {
          case 'phase':
            setPhase(ev.phase);
            setInst(0);
            setProgress(0);
            setExtending(null);
            if (ev.phase === 'done') setFinishedAt(new Date());
            break;
          case 'ping-progress':
            setLivePing(ev.value);
            setProgress(ev.progress);
            break;
          case 'sample':
            setInst(ev.mbps);
            setProgress(ev.progress);
            setSamples((prev) => [...prev, ev]);
            break;
          case 'result':
            setResults((prev) => ({ ...prev, [ev.key]: ev.value }));
            break;
          case 'phase-failed':
            setFailures((prev) => [...prev, `${ev.phase}: ${ev.message}`]);
            break;
          case 'phase-warning':
            setFailures((prev) => [...prev, ev.message]);
            break;
          case 'phase-extended':
            setExtending(ev.reason);
            break;
          default:
            break;
        }
      });
    } catch (err) {
      setError(err?.message || 'The test could not be completed.');
      setPhase('idle');
    }
  }, []);

  const stop = useCallback(() => {
    testRef.current?.abort();
    setPhase('idle');
  }, []);

  const runChecks = useCallback(async () => {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await new SpeedTest(CONFIG).diagnose());
    } finally {
      setChecking(false);
    }
  }, []);

  const dial = useMemo(() => {
    if (phase === 'ping') return { value: fmtMs(livePing), unit: 'ms', speed: null };
    if (phase === 'download' || phase === 'upload') {
      return { value: fmtSpeed(inst), unit: 'Mbps', speed: inst };
    }
    if (phase === 'done') {
      return { value: fmtSpeed(results.download), unit: 'Mbps', speed: results.download };
    }
    return { value: '—', unit: 'Mbps', speed: null };
  }, [phase, inst, livePing, results.download]);

  const spans = useMemo(() => {
    const max = (p) => samples.reduce((m, s) => (s.phase === p && s.t > m ? s.t : m), 0);
    return { download: max('download') / 1000, upload: max('upload') / 1000 };
  }, [samples]);

  const verdict = phase === 'done'
    ? verdictFor(results.download, results.upload, results.ping)
    : null;

  const copy = async () => {
    const text = [
      `Download  ${fmtSpeed(results.download)} Mbps`,
      `Upload    ${fmtSpeed(results.upload)} Mbps`,
      `Ping      ${fmtMs(results.ping)} ms`,
      `Jitter    ${fmtMs(results.jitter)} ms`,
      info?.processedString ? `Client    ${info.processedString}` : null,
      (finishedAt || new Date()).toLocaleString(),
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const stepState = (key) => {
    const at = ORDER.indexOf(phase);
    const mine = ORDER.indexOf(key);
    if (phase === 'done') return 'done';
    if (at === mine) return 'active';
    return at > mine ? 'done' : 'idle';
  };

  return (
    <main className="shell">
      <header className="rail">
        <h1 className="wordmark">Speedtest</h1>
        <div className="rail__right">
          <p className="rail__meta">
            {configured
              ? (info?.processedString || 'Reading connection…')
              : 'No backend configured'}
          </p>
          <button
            type="button"
            className="lamp"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light' : 'Dark'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5Z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {!configured && (
        <div className="alert">
          <span className="tag" style={{ color: 'var(--pen-up)' }}>Setup needed</span>
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set{' '}
            <code>VITE_SPEEDTEST_URL</code> to your Worker URL. Deploy the worker
            first with <code>npm run deploy:worker</code>.
          </p>
        </div>
      )}

      <div className="steps">
        {STEPS.map((s) => {
          const state = stepState(s.key);
          return (
            <div
              key={s.key}
              className="steps__item"
              data-state={state}
              style={{ '--pen': `var(${s.pen})`, '--fill': state === 'active' ? progress : 0 }}
            >
              <span className="steps__bar" />
              <span>{s.label}</span>
            </div>
          );
        })}
      </div>

      <Dial
        value={dial.value}
        unit={dial.unit}
        speed={dial.speed}
        pen={PENS[phase]}
        phase={phase}
        label={LABELS[phase]}
        theme={theme}
      />

      <div className="controls">
        {running ? (
          <button type="button" className="start start--ghost" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="start" onClick={start} disabled={!configured}>
            {phase === 'done' ? 'Run again' : 'Start test'}
          </button>
        )}
      </div>

      {error && (
        <div className="alert">
          <span className="tag" style={{ color: 'var(--pen-up)' }}>Test stopped</span>
          <p>{error}</p>
        </div>
      )}

      {failures.length > 0 && (
        <div className="alert">
          <span className="tag" style={{ color: 'var(--pen-up)' }}>Incomplete run</span>
          {failures.map((f) => <p key={f}>{f}</p>)}
        </div>
      )}

      <Trace
        samples={samples}
        rampUp={CONFIG.rampUp}
        dlDuration={CONFIG.dlDuration}
        ulDuration={CONFIG.ulDuration}
        theme={theme}
      />

      <Readouts results={results} phase={phase} inst={inst} />

      {verdict && (
        <div className="verdict">
          <span className="verdict__item"><b>Good for</b>{verdict.video}</span>
          <span className="verdict__item"><b>Calls</b>{verdict.calls}</span>
          {verdict.gaming && <span className="verdict__item"><b>Gaming</b>{verdict.gaming}</span>}
          {finishedAt && (
            <span className="verdict__item"><b>At</b>{finishedAt.toLocaleTimeString()}</span>
          )}
        </div>
      )}

      <div className="note">
        <p className="note__text">
          {CONFIG.dlStreams} download streams · {CONFIG.ulStreams} upload streams · first{' '}
          {(CONFIG.rampUp / 1000).toFixed(1)}s of each phase excluded
          {spans.download ? ` · download ran ${spans.download.toFixed(0)}s` : ''}
          {spans.upload ? `, upload ${spans.upload.toFixed(0)}s` : ''}
          {running && extending ? ` · extending (${extending})` : ''}
        </p>
        <span className="note__actions">
          {phase === 'done' && (
            <button type="button" className="linkish" onClick={copy}>
              {copied ? 'Copied' : 'Copy result'}
            </button>
          )}
          <button
            type="button"
            className="linkish"
            onClick={runChecks}
            disabled={running || checking || !configured}
          >
            {checking ? 'Checking…' : 'Check endpoints'}
          </button>
        </span>
      </div>

      {checks && (
        <div className="checks">
          <span className="tag">Endpoint check · {CONFIG.baseUrl}</span>
          <ul>
            {checks.map((c) => (
              <li key={c.name} className={c.ok ? 'is-ok' : 'is-bad'}>
                <b>{c.ok ? 'OK' : 'FAIL'}</b>
                <span>{c.name}</span>
                <em>{c.detail}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
