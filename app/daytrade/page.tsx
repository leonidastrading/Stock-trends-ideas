import AutoRefresh from "@/components/AutoRefresh";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { DAYTRADE, daytradeBoard, daytradeSnaps, rankMove, runDaytrade, type DtSnap } from "@/lib/scout/daytrade";
import { notStock } from "@/lib/scout/st-trending";
import { etLabel, fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (a: number | null, b: number | null) => (a && b ? (b / a - 1) * 100 : null);
const fmt = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
const cls = (x: number | null) => (x === null ? "muted" : x >= 0 ? "pos" : "neg");
const k = (n: number | null) => (n === null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const usd = (n: number | null | undefined) => (n ? `$${n.toFixed(2)}` : "—");

/** Daytrade: Stocktwits' trending ten, read every five minutes. */
export default async function DaytradePage() {
  if (!hasDatabase()) return <SetupNotice />;
  const data = marketDataFromEnv();
  let snaps = await daytradeSnaps().catch(() => [] as DtSnap[]);
  // The job rests overnight: opening the page then (or before its first run) takes a reading itself.
  const last = snaps[snaps.length - 1];
  if (!last || Date.now() - Date.parse(last.takenAt) > (DAYTRADE.everyMin + 1) * 60000) {
    const took = await runDaytrade({ data }).catch(() => "");
    if (/^daytrade: [A-Z]/.test(took)) snaps = await daytradeSnaps().catch(() => snaps);
  }
  const board = daytradeBoard(snaps);
  if (!board.latest) return (<><h1>Daytrade</h1><p className="small muted">Stocktwits&apos; trending ten is read every five minutes; the first reading has not arrived yet.</p><AutoRefresh seconds={60} /></>);

  const syms = [...new Set([...board.rows, ...board.gone].filter((i) => !notStock(i)).map((i) => i.symbol))];
  const live = (syms.length && data?.getSnapshots ? await data.getSnapshots(syms).catch(() => ({})) : {}) as Record<string, { price: number; prevClose: number | null }>;
  const hasBefore = snaps.length > 1;

  return (
    <>
      <AutoRefresh seconds={60} />
      <h1>Daytrade</h1>
      <p className="small secondary">The top ten of <a href="https://stocktwits.com/sentiment" target="_blank" rel="noreferrer">Stocktwits&apos; trending list</a>, read every five minutes. Last read {fmtEtAgo(board.latest.takenAt)}; {board.readsToday} reading{board.readsToday === 1 ? "" : "s"} today. Prices refresh every minute while this page is open.</p>

      <section className="card">
        <h2>Trending now</h2>
        <div className="table-wrap"><table>
          <thead><tr><th className="num">#</th><th>Move</th><th>Stock</th><th className="num">Price</th><th className="num">Today</th><th className="num">Since it joined</th><th>On the list since</th><th className="num">Watchers</th><th>Why it is trending (Stocktwits)</th></tr></thead>
          <tbody>{board.rows.map((r) => {
            const m = rankMove(r.rank, r.rankBefore, hasBefore);
            const foreign = notStock(r);
            const now = live[r.symbol]?.price ?? r.price;
            const today = pct(live[r.symbol]?.prevClose ?? r.prevClose, now);
            const since = pct(r.firstPrice, now);
            return (
              <tr key={r.symbol}>
                <td className="num"><b>{r.rank}</b></td>
                <td className={`small ${m.dir === "up" || m.dir === "new" ? "pos" : m.dir === "down" ? "neg" : "muted"}`} style={{ whiteSpace: "nowrap" }} title="Against the reading five minutes earlier">{m.text || "–"}</td>
                <td>{foreign ? <a className="ticker" href={`https://stocktwits.com/symbol/${encodeURIComponent(r.symbol)}`} target="_blank" rel="noreferrer">{r.symbol}</a> : <Ticker symbol={r.symbol} />}<div className="small muted">{r.name}{foreign ? " · not a US stock" : ""}</div></td>
                <td className="num">{usd(now)}</td>
                <td className={`num ${cls(today)}`}>{fmt(today)}</td>
                <td className={`num ${cls(since)}`} title={r.firstPrice ? `From ${usd(r.firstPrice)} when it joined the list` : "No price when it joined the list"}>{fmt(since)}</td>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{etLabel(r.firstSeen, true)}<div className="muted">{r.reads} of {board.readsToday} readings · best #{r.bestRank}</div></td>
                <td className="num">{k(r.watchers)}</td>
                <td className="small" style={{ minWidth: 260 }}>{r.summary ?? <span className="muted">no summary</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>

      {board.gone.length > 0 && (
        <section className="card">
          <h2>Dropped off today</h2>
          <p className="small muted">On the top ten earlier today and not on it now, latest first.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>On the list</th><th className="num">Best</th><th className="num">Price</th><th className="num">Since it joined</th></tr></thead>
            <tbody>{board.gone.map((g) => {
              const now = live[g.symbol]?.price ?? null;
              const since = pct(g.firstPrice, now);
              return (
                <tr key={g.symbol}>
                  <td>{notStock(g) ? g.symbol : <Ticker symbol={g.symbol} />} <span className="small muted">{g.name}</span></td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{etLabel(g.firstSeen, true)} to {etLabel(g.lastSeen, true)} <span className="muted">· {g.reads} reading{g.reads === 1 ? "" : "s"}</span></td>
                  <td className="num">#{g.bestRank}</td>
                  <td className="num">{usd(now)}</td>
                  <td className={`num ${cls(since)}`}>{fmt(since)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </section>
      )}
      <p className="small muted">Trending list and summaries: Stocktwits. Prices: Alpaca (IEX). &quot;Since it joined&quot; is from the price at the first reading today that had the stock in the top ten. Not investment advice.</p>
    </>
  );
}
