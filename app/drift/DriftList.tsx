import CardChips from "@/components/CardChips";
import Ticker from "@/components/Ticker";
import type { MarketData } from "@/lib/alpaca";
import { DRIFT_LIST, listResult, type ListEntry } from "@/lib/scout/drift-list";
import type { StoredCard } from "@/lib/scout/store";
import { fmtEt } from "@/lib/time";
import { bookStats } from "./DriftBook";
import DriftResearch from "./DriftResearch";

const pct = (x: number | null) => (x === null ? "?" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`);
const BASIS: Record<ListEntry["basis"], string> = { listing: "the price when it was listed", "minute bar": "the 1-minute bar at the time it was listed", open: "the next open (listed while the market was closed)" };

/** The list's own paper book: every setup shorted on paper from the moment it first appeared, with no card. */
export default async function DriftList({ entries, cards, data, listed = [] }: { entries: ListEntry[]; cards: StoredCard[]; data: MarketData | null; /** Stocks on the list right now (only those can be researched from here). */ listed?: string[] }) {
  const open = entries.filter((e) => !e.exitDate);
  const closed = entries.filter((e) => e.exitDate);
  const snaps = (open.length && data?.getSnapshots ? await data.getSnapshots([...new Set([...open.map((e) => e.symbol), "SPY"])]).catch(() => ({})) : {}) as Record<string, { price: number; delayed?: boolean }>;
  const spyNow = snaps.SPY?.price ?? null;
  const done = closed.map((e) => listResult(e, null, null)).filter((r): r is NonNullable<typeof r> => !!r);
  const stats = bookStats(done);
  const live = open.map((e) => ({ e, r: listResult(e, snaps[e.symbol]?.price ?? null, spyNow) }));
  const liveStats = bookStats(live.map((x) => x.r).filter((r): r is NonNullable<typeof r> => !!r));
  const cardsOn = (sym: string) => cards.filter((c) => c.primaryTicker === sym || c.card.tickers.some((t) => t.symbol === sym)).map((c) => ({ id: c.id, createdAt: c.createdAt, status: c.status, direction: c.direction, primaryTicker: c.primaryTicker, tickers: c.card.tickers.map((t) => t.symbol) }));
  return (
    <section className="card" id="list-book">
      <h2>Paper shorts from the list ({open.length} open)</h2>
      <p className="small secondary">Every setup is shorted on paper the moment it first appears on this page, at the price of the scan that listed it, or at the next open when the market is closed. No card and no AI are needed, and nothing is entered before you could see it. Each is held {DRIFT_LIST.holdDays} days, also after it leaves the list, then closed. This is the record of the list itself; the cards further down are the desk&apos;s researched picks, scored apart.</p>
      {entries.length === 0 ? <p className="small muted">Nothing yet: the first entries are written at the next hourly scan.</p> : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>News</th><th>Joined the list / entry</th><th className="num">Held</th><th className="num">Return</th><th className="num">vs SPY</th><th>Exit by</th><th>Cards</th><th></th></tr></thead>
            <tbody>{live.map(({ e, r }) => (
              <tr key={`${e.symbol}-${e.eventDate}`}>
                <td><Ticker symbol={e.symbol} /></td>
                <td className="small">{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.eventKind}</a> : e.eventKind} <span className="muted">{e.eventDate.slice(5)}</span></td>
                <td className="small" title={`Entry price: ${BASIS[e.basis]}`}>{fmtEt(e.listedAt)}{e.entryPrice ? <> @ <b>${e.entryPrice.toFixed(2)}</b>{e.basis === "open" ? <span className="muted"> ({e.entryDate} open)</span> : e.basis === "minute bar" ? <span className="muted"> (1-min bar)</span> : null}</> : <span className="muted"> · enters at the next open</span>}</td>
                <td className="num">{r ? `${r.days}d` : "—"}</td>
                <td className={`num ${r ? (r.ret >= 0 ? "pos" : "neg") : "muted"}`}>{r ? pct(r.ret) : e.entryPrice ? "no price" : "—"}{r && snaps[e.symbol]?.delayed ? <span className="muted small" title="Priced from the whole market, 15 minutes delayed"> ·15m</span> : null}</td>
                <td className={`num ${r?.vsSpy == null ? "muted" : r.vsSpy >= 0 ? "pos" : "neg"}`}>{r?.vsSpy == null ? "—" : pct(r.vsSpy)}</td>
                <td className="small">{e.exitBy ?? "—"}</td>
                <td className="small">{cardsOn(e.symbol).length ? <CardChips cards={cardsOn(e.symbol)} max={3} symbol={e.symbol} /> : <span className="muted">none</span>}</td>
                <td className="small">{listed.includes(e.symbol) ? <DriftResearch symbol={e.symbol} again={cardsOn(e.symbol).length > 0} small /> : <span className="muted" title="Only stocks still on the list can be researched from here">off the list</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="small muted">
            Open now: {liveStats.n} priced{liveStats.mean === null ? "" : `, ${pct(liveStats.mean)} average vs SPY, ${liveStats.wins} of ${liveStats.n} ahead of SPY`}.
            {" "}Closed: {stats.n}{stats.mean === null ? " (the first close is 28 days after the first entry)" : `, ${Math.round((stats.wins / stats.n) * 100)}% beat SPY, ${pct(stats.mean)} mean and ${pct(stats.median)} median vs SPY`}.
            {" "}Returns are for the short (a falling stock is a gain); &quot;vs SPY&quot; adds SPY&apos;s move over the same days. Open positions prove little: only closed ones count.
          </p>
          {closed.length > 0 && (
            <details>
              <summary className="small">Closed ({closed.length})</summary>
              <div className="table-wrap"><table>
                <thead><tr><th>Stock</th><th>News</th><th>Entry</th><th>Exit</th><th className="num">Return</th><th className="num">vs SPY</th></tr></thead>
                <tbody>{closed.map((e) => { const r = listResult(e, null, null); return (
                  <tr key={`${e.symbol}-${e.eventDate}`}>
                    <td><Ticker symbol={e.symbol} /></td>
                    <td className="small">{e.eventKind} <span className="muted">{e.eventDate.slice(5)}</span></td>
                    <td className="small">{e.entryDate} @ ${e.entryPrice?.toFixed(2)}</td>
                    <td className="small">{e.exitDate} @ ${e.exitPrice?.toFixed(2)}</td>
                    <td className={`num ${r ? (r.ret >= 0 ? "pos" : "neg") : "muted"}`}>{r ? pct(r.ret) : "—"}</td>
                    <td className={`num ${r?.vsSpy == null ? "muted" : r.vsSpy >= 0 ? "pos" : "neg"}`}>{r?.vsSpy == null ? "—" : pct(r.vsSpy)}</td>
                  </tr>
                ); })}</tbody>
              </table></div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
