import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { pickSignals } from "@/lib/scout/filings";
import * as store from "@/lib/scout/store";
import { addDays, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (v: number | null) => (v === null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

export default async function FilingsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const [q, buys, alerts, candidates] = await Promise.all([store.secQueueStatus(), store.insiderBuysSince(addDays(today, -30)), store.filingAlertsSince(addDays(today, -30)), store.candidatesSince(30)]);
  const signals = pickSignals(buys, alerts, today);
  const researched = candidates.filter((c) => c.term.startsWith("filing: ") || c.term.startsWith("insider: "));
  const eightKs = alerts.filter((a) => a.kind === "8-K");
  const d13 = alerts.filter((a) => a.kind === "13D");
  return (
    <>
      <h1>Filings</h1>
      <section className="card notice small">
        SEC filings the news evidence singles out, read from EDGAR&apos;s daily index the day after they are filed: <b>insider open-market purchases</b> (Form 4, code P, not under a 10b5-1 plan; &quot;opportunistic&quot; when outside the insider&apos;s usual calendar month), <b>new activist stakes</b> (Schedule 13D) and <b>8-Ks with bad-news items</b> (restatement, cyber incident, auditor change, impairment, restructuring, officer departure).
        The strongest go to research as cards, at most three a day: restatements and cyber incidents first, then new 13Ds, then clustered or opportunistic insider buying.
        <div style={{ marginTop: 6 }}>Queue: {q.pending} to read · {q.done} read · {q.errors} errors · daily indexes loaded: {q.days.join(", ") || "none yet"}.</div>
      </section>

      <section className="card">
        <h2>Signals now</h2>
        {signals.length === 0 ? <p className="small muted">None yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Kind</th><th>Stock</th><th>Why</th><th>Researched</th></tr></thead>
            <tbody>{signals.map((s) => {
              const c = researched.find((r) => r.term.toLowerCase().startsWith(s.term.toLowerCase().split(" ").slice(0, 2).join(" ")));
              return (
                <tr key={s.term}>
                  <td><span className="tag">{s.kind}</span></td>
                  <td><b className={s.direction === "long" ? "pos" : "neg"}>{s.direction === "long" ? "▲" : "▼"} {s.symbol}</b></td>
                  <td className="small">{s.trigger[0]?.note}</td>
                  <td className="small">{c ? (c.cardId ? <a href={`/candidates?days=30#card-${c.cardId}`}>card #{c.cardId}</a> : `${c.outcome}${c.reason ? `: ${c.reason}` : ""}`) : <span className="muted">queued</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h2>Insider purchases, last 30 days</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Filed</th><th>Stock</th><th>Insider</th><th className="num">Value</th><th className="num">+ holding</th><th>Pattern</th></tr></thead>
          <tbody>
            {buys.slice(0, 60).map((b) => (
              <tr key={b.accession}>
                <td className="small">{b.filed}</td>
                <td><b>{b.symbol}</b> <span className="small muted">{b.issuerName}</span></td>
                <td className="small">{b.owner} <span className="muted">({b.role})</span></td>
                <td className="num">{usd(b.value)}</td>
                <td className="num">{b.pctIncrease === null ? "—" : `+${b.pctIncrease}%`}</td>
                <td className="small">{b.routine === true ? <span className="muted">routine</span> : b.routine === false ? <span className="pos">opportunistic</span> : <span className="muted">no history</span>}</td>
              </tr>
            ))}
            {buys.length === 0 && <tr><td colSpan={6} className="muted">None read yet. The queue is worked through on each hourly story call and after the close.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>New 13D stakes</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Filed</th><th>Company</th><th>Filed by</th></tr></thead>
          <tbody>
            {d13.map((a) => <tr key={a.accession}><td className="small">{a.filed}</td><td>{a.symbol ? <b>{a.symbol} </b> : null}<span className="small">{a.company}</span></td><td className="small">{a.filer}</td></tr>)}
            {d13.length === 0 && <tr><td colSpan={3} className="muted">None yet.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>8-Ks with bad-news items</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Filed</th><th>Company</th><th>Items</th></tr></thead>
          <tbody>
            {eightKs.map((a) => <tr key={a.accession}><td className="small">{a.filed}</td><td>{a.symbol ? <b>{a.symbol} </b> : null}<span className="small">{a.company}</span></td><td className="small">{a.items.join("; ")}</td></tr>)}
            {eightKs.length === 0 && <tr><td colSpan={3} className="muted">None yet.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
