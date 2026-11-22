import Ticker from "@/components/Ticker";
import { BIG_CUSTOMERS, READTHROUGH, recentReadthroughs } from "@/lib/scout/readthrough";
import { fmtEtAgo } from "@/lib/time";

/** Dots page: big customers' capex raises and the suppliers that had not moved yet. */
export default async function Readthrough() {
  const events = await recentReadthroughs(8).catch(() => []);
  return (
    <section className="card section" id="readthrough">
      <h2>Supply-chain read-through</h2>
      <p className="small muted">
        When a big customer ({[...new Set(Object.values(BIG_CUSTOMERS))].join(", ")}) raises its capital-spending plans in the news, the scout lists its suppliers (from 10-Ks that name it as a share of revenue, web search and the AI&apos;s knowledge, each marked),
        checks which have not moved since the news (less than +{READTHROUGH.notMovedPct} points against SPY), and sends the best {READTHROUGH.researchPerEvent} to research. Those cards score as &quot;Scout · supply-chain read-through&quot;. At most {READTHROUGH.eventsPerDay} events a day. Earnings-call transcripts are not used (no free source).
      </p>
      {events.length === 0 && <p className="small muted">No capex raises spotted yet.</p>}
      {events.map((e) => (
        <div key={e.id} id={`readthrough-${e.id}`} className="small" style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <b>{BIG_CUSTOMERS[e.customer] ?? e.customer}</b> · {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.headline}</a> : e.headline} <span className="muted">· {e.etDate} · checked {fmtEtAgo(e.createdAt)}</span>
          <div className="table-wrap"><table>
            <thead><tr><th>Supplier</th><th>Supplies</th><th>Evidence</th><th className="num">Since news vs SPY</th><th className="num">Confidence</th><th>Research</th></tr></thead>
            <tbody>{e.suppliers.slice().sort((a, b) => b.confidence - a.confidence).map((s) => {
              const r = e.researched.find((x) => x.ticker === s.supplier);
              const card = r?.outcome.match(/card #(\d+)/)?.[1];
              return <tr key={s.supplier}><td><Ticker symbol={s.supplier} /> <span className="muted">{s.name}</span></td><td>{s.supplies}</td><td>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.evidence}</a> : s.evidence}</td><td className={`num ${s.excess === null ? "muted" : s.excess >= READTHROUGH.notMovedPct ? "" : "pos"}`}>{s.excess === null ? "—" : `${s.excess > 0 ? "+" : ""}${s.excess}`}</td><td className="num">{s.confidence}</td><td>{card ? <a href={`/cards/${card}`}>card #{card}</a> : r ? <span className="muted">{r.outcome}</span> : ""}</td></tr>;
            })}</tbody>
          </table></div>
        </div>
      ))}
    </section>
  );
}
