import SetupNotice from "@/components/SetupNotice";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { housePtrUrl } from "@/lib/sources/house";
import { byMember, bySymbol, CONGRESS_LOOKBACK_DAYS, congressPerformance, type BuyResult } from "@/lib/scout/congress";
import * as store from "@/lib/scout/store";
import { addDays, daysBetween, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);
const pct = (v: number | null) => (v === null ? <span className="muted">—</span> : <span className={v >= 0 ? "pos" : "neg"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</span>);
const txClass = (tx: string) => (tx === "buy" ? "pos" : tx === "exchange" ? "" : "neg");

export default async function CongressPage({ searchParams }: { searchParams: Promise<{ member?: string; symbol?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const now = new Date();
  const today = toEt(now).date;
  const data = marketDataFromEnv();
  const [all, status, perf] = await Promise.all([
    store.congressTradesSince(addDays(today, -CONGRESS_LOOKBACK_DAYS)),
    store.congressFilingsStatus(),
    data ? panel("congress-perf", 360, () => congressPerformance(data, now), 15_000) : Promise.resolve({ data: null, updatedAt: null, error: "no market data keys" }),
  ]);
  const perfBy = new Map((perf.data ?? []).map((r: BuyResult) => [`${r.docId}:${r.ord}`, r]));
  const member = sp.member?.trim() || null;
  const symbol = sp.symbol?.trim().toUpperCase() || null;
  const trades = all.filter((t) => (!member || t.member === member) && (!symbol || t.symbol === symbol));
  const last30 = bySymbol(all, addDays(today, -30));
  const clusters = last30.filter((a) => a.cluster);
  const members = byMember(all).map((m) => {
    const res = (perf.data ?? []).filter((r) => r.member === m.member && r.sinceFilingVsSpy !== null && daysBetween(r.filed, r.asOf ?? r.filed) >= 5);
    return { ...m, followN: res.length, followAvg: res.length ? res.reduce((a, r) => a + (r.sinceFilingVsSpy ?? 0), 0) / res.length : null };
  });
  const filtered = member || symbol;

  return (
    <>
      <h1>Congress trades{member ? `: ${member}` : symbol ? `: ${symbol}` : ""}</h1>
      <section className="card notice small">
        Stock trades that members of the House report under the STOCK Act, read from the House Clerk&apos;s periodic transaction reports (official PDFs) and kept as filed. Amounts are the ranges members report; dollar figures here are range midpoints.
        Members have up to 45 days to report, so the column that matters for following them is <b>since filing</b>: the move from the first close after the report became public, against SPY over the same days. Paper filings are scanned images and cannot be read.
        Senate reports and the President&apos;s (OGE 278-T) are not read yet.
        <div style={{ marginTop: 6 }}>Reports read: {status.read} ({status.withTrades} with listed stocks, {status.scanned} scanned paper, {status.errors} missing) · latest filed {status.latest ?? "none yet"} · prices {perf.updatedAt ? `as of the last refresh` : perf.error ? <span className="warn">unavailable ({perf.error})</span> : "not loaded yet"}.</div>
        {filtered && <div style={{ marginTop: 6 }}><a href="/congress">← all members</a></div>}
      </section>

      {!filtered && (
        <section className="card">
          <h2>Bought by several members, last 30 days</h2>
          <p className="small secondary">By filing date. A cluster is three or more members buying, or two buying at least $100k between them, with fewer members selling.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Bought by</th><th className="num">Buys</th><th className="num">Sells</th><th className="num">Bought (est.)</th><th>Last filed</th></tr></thead>
            <tbody>
              {(clusters.length ? clusters : last30.slice(0, 12)).map((a) => (
                <tr key={a.symbol}>
                  <td><a href={`/congress?symbol=${a.symbol}`}><b className="accent">{a.symbol}</b></a>{a.cluster && <span className="tag promoted" style={{ marginLeft: 6 }}>cluster</span>}</td>
                  <td className="small">{a.buyers.join(", ") || <span className="muted">none</span>}{a.sellers.length ? <span className="muted"> · sold by {a.sellers.join(", ")}</span> : null}</td>
                  <td className="num">{a.buys}</td><td className="num">{a.sells}</td><td className="num">{a.buyUsd ? usd(a.buyUsd) : "—"}</td><td className="small">{a.lastFiled}</td>
                </tr>
              ))}
              {last30.length === 0 && <tr><td colSpan={6} className="muted">No reports read yet; they load with housekeeping (hourly).</td></tr>}
            </tbody>
          </table></div>
          {!clusters.length && last30.length > 0 && <p className="small muted">No clusters right now; the most-bought stocks are shown instead.</p>}
        </section>
      )}

      <section className="card">
        <h2>{filtered ? "Trades" : "Latest trades"}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Filed</th><th>Member</th><th>Stock</th><th>Trade</th><th>Owner</th><th>Amount</th><th>Traded</th><th className="num">Late by</th><th className="num">Since trade vs SPY</th><th className="num">Since filing vs SPY</th></tr></thead>
          <tbody>
            {trades.slice(0, filtered ? 300 : 80).map((t) => {
              const r = perfBy.get(`${t.docId}:${t.ord}`);
              return (
                <tr key={`${t.docId}:${t.ord}`}>
                  <td className="small"><a href={housePtrUrl({ docId: t.docId, year: t.year ?? Number(t.filed.slice(0, 4)) })} target="_blank" rel="noreferrer">{t.filed}</a></td>
                  <td className="small"><a href={`/congress?member=${encodeURIComponent(t.member)}`}>{t.member}</a> <span className="muted">{t.stateDst}</span></td>
                  <td><a href={`/congress?symbol=${t.symbol}`}><b className="accent">{t.symbol}</b></a>{t.assetType === "option" && <span className="tag">option</span>}</td>
                  <td className={`small ${txClass(t.tx)}`}>{t.tx}</td>
                  <td className="small secondary">{t.owner}</td>
                  <td className="small">{t.amount}</td>
                  <td className="small">{t.txDate}</td>
                  <td className="num small">{daysBetween(t.txDate, t.filed)}d</td>
                  <td className="num small">{r ? pct(r.sinceTradeVsSpy) : <span className="muted">—</span>}</td>
                  <td className="num small">{r ? pct(r.sinceFilingVsSpy) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
            {trades.length === 0 && <tr><td colSpan={10} className="muted">None in the last {CONGRESS_LOOKBACK_DAYS} days.</td></tr>}
          </tbody>
        </table></div>
        <p className="small muted">Returns are for buys of listed stocks only. The filing date links to the official report.</p>
      </section>

      {!filtered && (
        <section className="card">
          <h2>Members, last {CONGRESS_LOOKBACK_DAYS} days</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Member</th><th className="num">Reports</th><th className="num">Trades</th><th className="num">Buys</th><th className="num">Sells</th><th className="num">Traded (est.)</th><th className="num">Typical delay</th><th className="num">Buys since filing vs SPY</th><th>Last filed</th></tr></thead>
            <tbody>
              {members.slice(0, 60).map((m) => (
                <tr key={m.member}>
                  <td className="small"><a href={`/congress?member=${encodeURIComponent(m.member)}`}>{m.member}</a> <span className="muted">{m.stateDst}</span></td>
                  <td className="num">{m.reports}</td><td className="num">{m.trades}</td><td className="num">{m.buys}</td><td className="num">{m.sells}</td>
                  <td className="num">{usd(m.tradedUsd)}</td>
                  <td className="num">{m.medianLagDays === null ? "—" : `${m.medianLagDays}d`}</td>
                  <td className="num">{m.followAvg === null ? <span className="muted">—</span> : <>{pct(Math.round(m.followAvg * 10) / 10)} <span className="small muted">avg of {m.followN}</span></>}</td>
                  <td className="small">{m.lastFiled}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="small muted">&quot;Buys since filing vs SPY&quot; averages buys at least five days past their filing. A few months of a few trades says little about skill.</p>
        </section>
      )}
    </>
  );
}
