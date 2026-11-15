/** A 0-100 dial: red (fear) through yellow to green (greed), with the reading and its label. */
export const moodLabel = (v: number) => (v < 25 ? "Extreme fear" : v < 45 ? "Fear" : v <= 55 ? "Neutral" : v <= 75 ? "Greed" : "Extreme greed");

export default function Gauge({ value, title, note }: { value: number | null; title: string; note?: string }) {
  const v = value === null ? null : Math.max(0, Math.min(100, value));
  const angle = Math.PI * (1 - (v ?? 50) / 100); // 180° at 0, 0° at 100
  const cx = 60, cy = 58, r = 46;
  const nx = cx + (r - 10) * Math.cos(angle), ny = cy - (r - 10) * Math.sin(angle);
  const label = v === null ? "not enough data" : moodLabel(v);
  const tone = v === null ? "muted" : v < 45 ? "neg" : v <= 55 ? "warn" : "pos";
  const id = `g-${title.replace(/\W+/g, "")}`;
  return (
    <div className="gauge card">
      <svg viewBox="0 0 120 70" width="132" height="77" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#e5484d" /><stop offset="50%" stopColor="#e9b949" /><stop offset="100%" stopColor="#46a758" />
          </linearGradient>
        </defs>
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={`url(#${id})`} strokeWidth="9" strokeLinecap="round" />
        {v !== null && <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text-primary)" strokeWidth="3.5" strokeLinecap="round" />}
        <circle cx={cx} cy={cy} r="5" fill="var(--text-primary)" />
      </svg>
      <div className="gauge-value">{v ?? "—"}</div>
      <div className="gauge-title">{title}</div>
      <div className={`gauge-label ${tone}`}>{label}</div>
      {note && <div className="gauge-note">{note}</div>}
    </div>
  );
}
