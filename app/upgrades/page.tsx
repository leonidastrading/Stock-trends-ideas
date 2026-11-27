import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { stat } from "@/lib/scout/rating-study";
import * as store from "@/lib/scout/store";
import { upgradeBook, upgradeResult, UPGRADES, type Upgrade } from "@/lib/scout/upgrades";
import { addDays, fmtEt, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`);
const tone = (x: number | null | undefined) => (x === null || x === undefined ? "muted" : x >= 0 ? "pos" : "neg");

/** Upgrades (up): broker upgrades to a buy rating, each a paper long from the moment it appeared. */
export default async function UpgradesPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const data = marketDataFromEnv();
  const [book, briefs] = await Promise.all([upgradeBook().catch(() => [] as Upgrade[]), store.cardBriefsSince(180).catch(() => [] as store.CardBrief[])]);
  const today = toEt(new Date()).date;
  const recent = book.filter((u) => !u.exitDate && u.day >= addDays(today, -UPGRADES.showDays));
  const snaps = (recent.length && data?.getSnapshots ? await data.getSnapshots([...new Set([...recent.map((u) => u.symbol), "SPY"])]).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const spyNow = snaps.SPY?.price ?? null;
  const rows = recent.map((u) => ({ u, r: upgradeResult(u, snaps[u.symbol]?.price ?? null, spyNow) }));
  const closed = book.filter((u) => u.exitDate).map((u) => upgradeResult(u, null, null)).filter((r): r is NonNullable<typeof r> => !!r);
  const closedStat = stat(closed.map((r) => (r.vsSpy === null ? null : r.vsSpy * 100)));
  const openStat = stat(rows.map((x) => (x.r?.vsSpy == null ? null : x.r.vsSpy * 100)));
  const cardsOn = (sym: string) => briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym));
  return (
    <>
      <h1>Drift</h1>
      <div className="toolbar"><span className="filter-links small"><a className="chip" href="/drift">Down drift (bad news)</a><a className="chip" href="/earnings">Earnings drift (up)</a><a className="chip active" href="/upgrades">Upgrades (up)</a></span></div>
      <details className="card section">
        <summary><b>How this page works</b> <span className="small muted">stocks a broker has just upgraded to a buy rating</span></summary>
        <div className="small secondary">
          <p>Every 15 minutes the scout reads the news stream for a broker upgrading one stock to Buy, Outperform, Overweight or the like (not to Neutral, and not a credit rating). The stock must be ${UPGRADES.minPrice} or more and trade ${UPGRADES.minDollarVolume / 1e6}M or more a day. Each one is bought on paper the moment it appears here: at the live price when the market is open, else at the next open. No card and no AI. It is held 60 trading days ({UPGRADES.holdDays} calendar days), then closed, and scored against SPY.</p>
          <p>Why: the scout&apos;s own rating-change study on the Drift page (2019 to 2026, 1,124 upgrades) found stocks keep rising after an upgrade: about +0.4% against SPY in 5 trading days, +1% in 20 and +2.8% in 60 from the next open, each unlikely to be chance. Downgrades showed no usable drift. It is a small average edge with wide scatter, so one name proves nothing: the record at the bottom is what counts.</p>
          <p>Started November 26, 2026, after Sanofi rose on an RBC upgrade and nothing in the scout looked at the long side.</p>
        </div>
      </details>
      <p className="small muted">{recent.length} upgrade{recent.length === 1 ? "" : "s"} in the last {UPGRADES.showDays} days · {book.filter((u) => !u.exitDate).length} paper longs open in all · {closed.length} closed</p>
      {book.length === 0 && <p className="small muted">Nothing yet: the first upgrades are read at the next pass (every 15 minutes, 6 AM to 8 PM ET).</p>}
      {rows.length > 0 && (
        <section className="card">
          <div className="table-wrap"><table>
            <thead><tr><th>Upgrade</th><th>Stock</th><th>Broker and rating</th><th>Paper long</th><th className="num">Return</th><th className="num">vs SPY</th><th>Cards</th><th></th></tr></thead>
            <tbody>{rows.map(({ u, r }) => (
              <tr key={`${u.symbol}-${u.day}`}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtEt(u.newsAt)}</td>
                <td><Ticker symbol={u.symbol} className="pos" /></td>
                <td className="small">{u.url ? <a href={u.url} target="_blank" rel="noreferrer">{u.brokers.join(", ") || "broker not named"}</a> : u.brokers.join(", ") || "broker not named"}: {u.from ? `${u.from} → ` : "to "}<b>{u.to}</b>{u.topBroker ? <span className="tag">top broker</span> : null}{u.brokers.length > 1 ? <span className="tag">{u.brokers.length} brokers</span> : null}</td>
                <td className="small">{u.entryPrice ? <>entered {u.entryDate} @ <b>${u.entryPrice.toFixed(2)}</b>{u.basis === "open" ? <span className="muted"> (open)</span> : null}{u.prevClose ? <span className="muted"> · ${u.prevClose.toFixed(2)} before the upgrade</span> : null}</> : <span className="muted">enters at the next open{u.prevClose ? ` · $${u.prevClose.toFixed(2)} before the upgrade` : ""}</span>}</td>
                <td className={`num ${tone(r?.ret)}`}>{pct(r?.ret)}</td>
                <td className={`num ${tone(r?.vsSpy)}`}>{pct(r?.vsSpy)}</td>
                <td className="small">{cardsOn(u.symbol).length ? <CardChips cards={cardsOn(u.symbol)} max={3} symbol={u.symbol} /> : <span className="muted">none</span>}</td>
                <td className="small"><ResearchButton symbol={u.symbol} term={`${u.symbol} upgrade`} kind="event" from={{ label: "Upgrades", url: "/upgrades" }} observation={`${u.brokers.join(" and ") || "A broker"} upgraded ${u.symbol} to ${u.to}${u.from ? ` from ${u.from}` : ""} on ${u.day}: "${u.headline}".${u.prevClose ? ` The stock closed at $${u.prevClose.toFixed(2)} before the upgrade.` : ""} Stocks tend to keep rising for weeks after an upgrade. Is that likely here, or is the move already done?`} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      <section className="card">
        <h2>The record</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Paper longs</th><th className="num">Count</th><th className="num">Average vs SPY</th><th className="num">Median</th><th className="num">Behind SPY</th></tr></thead>
          <tbody>
            <tr><td>Closed (held the full 60 trading days)</td><td className="num">{closedStat.n}</td><td className={`num ${tone(closedStat.mean)}`}>{closedStat.mean === null ? "—" : `${closedStat.mean > 0 ? "+" : ""}${closedStat.mean}%`}</td><td className="num">{closedStat.median === null ? "—" : `${closedStat.median > 0 ? "+" : ""}${closedStat.median}%`}</td><td className="num">{closedStat.negShare === null ? "—" : `${closedStat.negShare}%`}</td></tr>
            <tr><td>Open, last {UPGRADES.showDays} days (at the latest price)</td><td className="num">{openStat.n}</td><td className={`num ${tone(openStat.mean)}`}>{openStat.mean === null ? "—" : `${openStat.mean > 0 ? "+" : ""}${openStat.mean}%`}</td><td className="num">{openStat.median === null ? "—" : `${openStat.median > 0 ? "+" : ""}${openStat.median}%`}</td><td className="num">{openStat.negShare === null ? "—" : `${openStat.negShare}%`}</td></tr>
          </tbody>
        </table></div>
        <p className="small muted">Only closed positions count as a result; the first close is {UPGRADES.holdDays} days after the first entry. The study says to expect an average of a few points against SPY, not big single moves.</p>
      </section>
    </>
  );
}
