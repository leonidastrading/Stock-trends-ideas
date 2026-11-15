import { toEt } from "@/lib/time";

interface Measured {
  measured?: Array<{ term: string; kind: string; sources: number; accelerating: number; score: number; candidate: boolean; cooldown: boolean }>;
  risingQueries?: Array<{ title: string; traffic: string }>;
  stoppedEarly?: string | null;
  discovery?: { headlinesRead: number; read: string | null; proposed: Array<{ term: string; kind: string; tickers: string[]; why: string }>; problems: string[]; error: string | null } | null;
}

/** The trend desk's last daily scan: discovery, watch-list measurements, Google rising queries. Folded by default. */
export default function TrendScan({ run }: { run: { startedAt: string; status: string; error: string | null; detail: unknown } }) {
  const measured = (run.detail as Measured | null) ?? null;
  return (
    <details className="card section">
      <summary><h2>Trend desk · last scan {toEt(new Date(run.startedAt)).date} · {run.status}{run.error ? ` · ${run.error}` : ""}</h2> <span className="small muted">watch-list measurements and discovery</span></summary>
      {measured?.stoppedEarly && <p className="warn small">{measured.stoppedEarly}</p>}
      {measured?.discovery && (
        <div className="card" style={{ marginBottom: 10 }}>
          <h3>Discovery · {measured.discovery.headlinesRead} headlines read</h3>
          {measured.discovery.read && <p className="small">{measured.discovery.read}</p>}
          {measured.discovery.error && <p className="small neg">{measured.discovery.error}</p>}
          {measured.discovery.proposed.length > 0 ? (
            <ul className="small">{measured.discovery.proposed.map((p) => <li key={p.term}><b>{p.term}</b> <span className="tag">{p.kind.replace("_", "-")}</span> {p.tickers.join(", ")} — {p.why}</li>)}</ul>
          ) : !measured.discovery.error && <p className="small muted">Nothing proposed today.</p>}
          {measured.discovery.problems.length > 0 && <p className="small muted">Inputs not available: {measured.discovery.problems.join("; ")}</p>}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Watch-list term</th><th>Kind</th><th className="num">Sources with data</th><th className="num">Accelerating</th><th className="num">Score</th><th>Result</th></tr></thead>
          <tbody>
            {(measured?.measured ?? []).slice().sort((a, b) => b.score - a.score).map((m) => (
              <tr key={m.term}><td>{m.term}</td><td className="small">{m.kind}</td><td className="num">{m.sources}</td><td className="num">{m.accelerating}</td><td className="num">{m.score}</td>
                <td className="small">{m.candidate ? (m.cooldown ? "candidate, but researched within 7 days" : "candidate") : "not accelerating"}</td></tr>
            ))}
            {!measured?.measured?.length && <tr><td colSpan={6} className="muted">No measurements recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      {measured?.risingQueries && measured.risingQueries.length > 0 && (
        <details style={{ marginTop: 8 }}><summary>Google rising queries seen (not on the watch-list; add any that matter)</summary>
          <p className="small">{measured.risingQueries.map((q) => `${q.title} (${q.traffic})`).join(" · ")}</p></details>
      )}
    </details>
  );
}
