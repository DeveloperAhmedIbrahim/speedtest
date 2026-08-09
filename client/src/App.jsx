import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dial from './components/Dial';
import Trace from './components/Trace';
import Readouts from './components/Readouts';
import { DEFAULTS, SpeedTest, fmtMs, fmtSpeed } from './lib/speedtest';

const CONFIG = {
  ...DEFAULTS,
  // Set VITE_SPEEDTEST_URL in .env, e.g. https://speedtest.example.net/server
  baseUrl: import.meta.env.VITE_SPEEDTEST_URL || '/server',
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

const EMPTY = { ping: null, jitter: null, download: null, upload: null };

export default function App() {
  const [phase, setPhase] = useState('idle');
  const [inst, setInst] = useState(0);
  const [livePing, setLivePing] = useState(null);
  const [results, setResults] = useState(EMPTY);
  const [samples, setSamples] = useState([]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState([]);
  const [checks, setChecks] = useState(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const testRef = useRef(null);
  const running = phase === 'ping' || phase === 'download' || phase === 'upload';

  useEffect(() => {
    const probe = new SpeedTest(CONFIG);
    probe.getInfo().then(setInfo);
    return () => testRef.current?.abort();
  }, []);

  const start = useCallback(async () => {
    testRef.current?.abort();
    const test = new SpeedTest(CONFIG);
    testRef.current = test;

    setResults(EMPTY);
    setSamples([]);
    setInst(0);
    setLivePing(null);
    setError(null);
    setFailures([]);
    setChecks(null);
    setCopied(false);
    setPhase('ping');

    try {
      await test.run((ev) => {
        switch (ev.type) {
          case 'phase':
            setPhase(ev.phase);
            setInst(0);
            break;
          case 'ping-progress':
            setLivePing(ev.value);
            break;
          case 'sample':
            setInst(ev.mbps);
            setSamples((prev) => [...prev, ev]);
            break;
          case 'result':
            setResults((prev) => ({ ...prev, [ev.key]: ev.value }));
            break;
          case 'phase-failed':
            setFailures((prev) => [...prev, `${ev.phase}: ${ev.message}`]);
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

  const runChecks = useCallback(async () => {
    setChecking(true);
    setChecks(null);
    try {
      const out = await new SpeedTest(CONFIG).diagnose();
      setChecks(out);
    } finally {
      setChecking(false);
    }
  }, []);

  const stop = useCallback(() => {
    testRef.current?.abort();
    setPhase('idle');
  }, []);

  const dial = useMemo(() => {
    if (phase === 'ping') {
      return { value: fmtMs(livePing), unit: 'ms', speed: null };
    }
    if (phase === 'download' || phase === 'upload') {
      return { value: fmtSpeed(inst), unit: 'Mbps', speed: inst };
    }
    if (phase === 'done') {
      return { value: fmtSpeed(results.download), unit: 'Mbps', speed: results.download };
    }
    return { value: '—', unit: 'Mbps', speed: null };
  }, [phase, inst, livePing, results.download]);

  const copy = async () => {
    const text = [
      `Download  ${fmtSpeed(results.download)} Mbps`,
      `Upload    ${fmtSpeed(results.upload)} Mbps`,
      `Ping      ${fmtMs(results.ping)} ms`,
      `Jitter    ${fmtMs(results.jitter)} ms`,
      info?.processedString ? `Client    ${info.processedString}` : null,
      new Date().toLocaleString(),
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="shell">
      <header className="rail">
        <h1 className="wordmark">Speedtest</h1>
        <p className="rail__meta">{info?.processedString || 'Reading connection…'}</p>
      </header>

      <Dial
        value={dial.value}
        unit={dial.unit}
        speed={dial.speed}
        pen={PENS[phase]}
        phase={phase}
        label={LABELS[phase]}
      />

      <div className="controls">
        {running ? (
          <button type="button" className="start start--ghost" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="start" onClick={start}>
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
      />

      <Readouts results={results} phase={phase} inst={inst} />

      <div className="note">
        <p className="note__text">
          {CONFIG.dlStreams} download streams · {CONFIG.ulStreams} upload streams · first{' '}
          {(CONFIG.rampUp / 1000).toFixed(1)}s of each phase excluded
        </p>
        <span className="note__actions">
          {phase === 'done' && (
            <button type="button" className="linkish" onClick={copy}>
              {copied ? 'Copied' : 'Copy result'}
            </button>
          )}
          <button type="button" className="linkish" onClick={runChecks} disabled={running || checking}>
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
