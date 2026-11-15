import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { OPTIONS_UNIVERSE } from "@/config/options";
import { pickSignals } from "@/lib/scout/filings";
import { OPTIONS_RULES } from "@/lib/scout/options-flow";
import * as store from "@/lib/scout/store";
import Ticker from "@/components/Ticker";
import ResearchButton from "./ResearchButton";
import { addDays, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (v: number | null) => (v === null ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

export default async function FilingsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const [q, buys, alerts, candidates, flags, optStatus] = await Promise.all([store.secQueueStatus(), store.insiderBuysSince(addDays(today, -30)), store.filingAlertsSince(addDays(today, -30)), store.candidatesSince(30), store.optionsFlagsSince(addDays(today, -30)), store.optionsLogStatus()]);
  const congress = await store.congressTradesSince(addDays(today, -45)).catch(() => []);
  const signals = pickSignals(buys, alerts, today, flags, congress);
  const researched = candidates.filter((c) => /^(filing|insider|options|congress|insider\+congress): /.test(c.term));
  // Stocks with a card in the last 30 days (by any route), so the button is not offered twice.
  const researchedSyms = new Set((await store.cardsSince(30).catch(() => [])).map((c) => c.primaryTicker));
  const buyNote = (b: store.InsiderBuyRow) => `Insider open-market purchase (SEC Form 4, filed ${b.filed}): ${b.owner ?? "an insider"} (${b.role ?? "insider"}) of ${b.issuerName ?? b.symbol} bought ${Math.round(b.shares ?? 0).toLocaleString("en-US")} shares at ${b.price === null ? "an unreported price" : `$${b.price}`} = ${usd(b.value)} on ${b.txDate ?? b.filed}${b.pctIncrease !== null ? `, adding ${b.pctIncrease}% to their holding` : ""}${b.routine === false ? ", outside their usual trading month (opportunistic)" : b.routine === true ? " (a routine purchase)" : ""}. Not under a 10b5-1 plan.`;
  const eightKs = alerts.filter((a) => a.kind === "8-K");
  const d13 = alerts.filter((a) => a.kind === "13D");
  return (
    <>
      <h1>Filings</h1>
      <section className="card notice small">
        SEC filings the news evidence singles out, read from EDGAR&apos;s daily index the day after they are filed: <b>insider open-market purchases</b> (Form 4, code P, not under a 10b5-1 plan; &quot;opportunistic&quot; when outside the insider&apos;s usual calendar month), <b>new activist stakes</b> (Schedule 13D) and <b>8-Ks with bad-news items</b> (restatement, cyber incident, auditor change, impairment, restructuring, officer departure).
        Also: stocks that <b>both insiders and members of Congress</b> bought within 45 days (strongest), and <b>Congress clusters</b> (see the Congress tab). The strongest go to research as cards, at most four a day: restatements and cyber incidents first, then new 13Ds, then clustered or opportunistic insider buying.
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
                  <td className="small">{c ? (c.cardId ? <a href={`/ideas?days=30&card=${c.cardId}#card-${c.cardId}`}>card #{c.cardId}</a> : `${c.outcome}${c.reason ? `: ${c.reason}` : ""}`) : <span className="muted">queued</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h2>Insider purchases, last 30 days</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Filed</th><th>Stock</th><th>Insider</th><th className="num">Value</th><th className="num">+ holding</th><th>Pattern</th><th>Research</th></tr></thead>
          <tbody>
            {buys.slice(0, 60).map((b) => (
              <tr key={b.accession}>
                <td className="small">{b.filed}</td>
                <td>{b.symbol ? <Ticker symbol={b.symbol} /> : null} <span className="small muted">{b.issuerName}</span></td>
                <td className="small">{b.owner} <span className="muted">({b.role})</span></td>
                <td className="num">{usd(b.value)}</td>
                <td className="num">{b.pctIncrease === null ? "—" : `+${b.pctIncrease}%`}</td>
                <td className="small">{b.routine === true ? <span className="muted">routine</span> : b.routine === false ? <span className="pos">opportunistic</span> : <span className="muted">no history</span>}</td>
                <td>{b.symbol ? (researchedSyms.has(b.symbol) ? <span className="small muted">researched</span> : <ResearchButton ticker={b.symbol} observation={buyNote(b)} />) : null}</td>
              </tr>
            ))}
            {buys.length === 0 && <tr><td colSpan={6} className="muted">None read yet. The queue is worked through on each hourly story call and after the close.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="card" id="options">
        <h2>Unusual options positioning, last 30 days</h2>
        <p className="small secondary">
          Once each trading day the scout reads the option chains of {OPTIONS_UNIVERSE.length} heavily traded stocks from Cboe and compares every contract&apos;s open interest with the day before.
          A flag is a new out-of-the-money position of at least {OPTIONS_RULES.minContracts.toLocaleString("en-US")} contracts, worth at least {usd(OPTIONS_RULES.minPremiumUsd)} in premium or {usd(OPTIONS_RULES.minNotionalUsd)} of stock, and at least {OPTIONS_RULES.minMultiple}× that stock&apos;s normal large day ({OPTIONS_RULES.baselineDays} days of history needed; before that only positions over {OPTIONS_RULES.noBaselineContracts.toLocaleString("en-US")} contracts and {usd(OPTIONS_RULES.noBaselinePremiumUsd)}).
          Open interest does not show who opened the position or which side they took, and most big put positions are hedges: a flag means look, not follow.
        </p>
        <p className="small muted">Log: {optStatus.stocks} stocks captured, latest {optStatus.latest ?? "none yet"}, {optStatus.days} day(s) compared so far.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Day</th><th>Contract</th><th className="num">New contracts</th><th className="num">Open now</th><th className="num">Premium</th><th className="num">Stock exposure</th><th className="num">× normal</th><th>Structure</th></tr></thead>
          <tbody>
            {flags.slice(0, 60).map((f) => (
              <tr key={f.date + f.contract}>
                <td className="small">{f.date}</td>
                <td><Ticker symbol={f.symbol} className={f.type === "put" ? "neg" : "pos"} /> <span className="small">{f.expiry} ${f.strike} {f.type}</span> <span className="small muted">(stock ${f.spot.toFixed(2)}, {Math.round(Math.abs(f.strike / f.spot - 1) * 100)}% out)</span></td>
                <td className="num">+{(f.oi - f.prevOi).toLocaleString("en-US")}</td>
                <td className="num small">{f.oi.toLocaleString("en-US")}</td>
                <td className="num">{f.premiumUsd ? usd(f.premiumUsd) : "—"}</td>
                <td className="num small">{usd(f.notionalUsd)}</td>
                <td className="num small">{f.multiple === null ? <span className="muted">no normal yet</span> : `${f.multiple}×`}</td>
                <td className="small">{f.structure ?? <span className="muted">single strike</span>}</td>
              </tr>
            ))}
            {flags.length === 0 && <tr><td colSpan={8} className="muted">None yet. The first capture is the baseline; flags start from the second trading day.</td></tr>}
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
