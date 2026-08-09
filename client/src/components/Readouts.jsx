import { fmtMs, fmtSpeed } from '../lib/speedtest';

function Cell({ label, value, unit, pen, live }) {
  return (
    <div className={`cell${live ? ' cell--live' : ''}`} style={{ '--pen': `var(${pen})` }}>
      <span className="tag">{label}</span>
      <span className="cell__value">
        {value}
        <span className="cell__unit">{unit}</span>
      </span>
    </div>
  );
}

export default function Readouts({ results, phase, inst }) {
  const dl = phase === 'download' ? inst : results.download;
  const ul = phase === 'upload' ? inst : results.upload;

  return (
    <div className="readouts">
      <Cell label="Download" value={fmtSpeed(dl)} unit="Mbps" pen="--pen-dn" live={phase === 'download'} />
      <Cell label="Upload" value={fmtSpeed(ul)} unit="Mbps" pen="--pen-up" live={phase === 'upload'} />
      <Cell label="Ping" value={fmtMs(results.ping)} unit="ms" pen="--pen-ping" live={phase === 'ping'} />
      <Cell label="Jitter" value={fmtMs(results.jitter)} unit="ms" pen="--pen-jit" live={phase === 'ping'} />
    </div>
  );
}
