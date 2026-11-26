import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { COT_MARKETS, cotReadings, gammaFor, type CotReading, type GammaProfile } from "@/lib/market/positioning";
import { fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INDEXES = ["SPY", "QQQ", "IWM"];
const big = (n: number) => { const a = Math.abs(n); return `${n < 0 ? "−" : "+"}$${a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : `${Math.round(a / 1e6)}M`}`; };

/** Positioning: futures (CFTC Commitments of Traders) and dealer gamma (estimated from Cboe option chains). */
export default async function PositioningPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const now = new Date();
  const [cot, gammas] = await Promise.all([
    panel<CotReading[]>("cot", 12 * 60, () => cotReadings(now), 25_000),
    Promise.all(INDEXES.map((s) => gammaFor(s, now).catch(() => null))),
  ]);
  const rows = (cot.data ?? []).slice().sort((a, b) => Math.abs(50 - (b.index3y ?? 50)) - Math.abs(50 - (a.index3y ?? 50)));
  return (
    <>
      <h1>Positioning</h1>
      <p className="small secondary">Who is already in the trade. Price is the last thing to move; positioning shows when a trade is crowded (room for a squeeze or reversal) or still has room to run. Context for the cards, not signals on their own: every card written now carries these readings, and the Scoring page shows whether going against a crowded side actually pays.</p>

      <section className="card section">
        <h2>Dealer gamma: index ETFs</h2>
        <p className="small muted">Estimated from Cboe&apos;s delayed option chains, assuming dealers are short the calls and long the puts that customers hold (most reliable for index options). <b>Above the flip</b> dealers buy dips and sell rips, so moves are damped and prices tend to pin near big strikes. <b>Below the flip</b> they chase moves, so they amplify. The call wall and put wall are the strikes holding the most gamma: they often act as resistance and support.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>ETF</th><th className="num">Price</th><th>Regime</th><th className="num">Gamma flip</th><th className="num">Put wall</th><th className="num">Call wall</th><th className="num">Net dealer gamma (per 1% move)</th><th className="small">Chain as of</th></tr></thead>
          <tbody>{INDEXES.map((s, i) => {
            const g = gammas[i] as GammaProfile | null;
            if (!g) return <tr key={s}><td><Ticker symbol={s} /></td><td colSpan={7} className="small muted">No estimate right now (Cboe chain unavailable).</td></tr>;
            return (
              <tr key={s}>
                <td><Ticker symbol={s} /></td><td className="num">${g.spot.toFixed(2)}</td>
                <td><span className={`tag ${g.regime === "damping" ? "ok" : "neg"}`}>{g.regime === "damping" ? "damping (positive gamma)" : "amplifying (negative gamma)"}</span></td>
                <td className="num">{g.flip !== null ? `$${g.flip}` : "—"}{g.flip !== null && <div className="small muted">{(((g.spot / g.flip) - 1) * 100).toFixed(1)}% {g.spot >= g.flip ? "above" : "below"}</div>}</td>
                <td className="num">{g.putWall !== null ? `$${g.putWall}` : "—"}</td><td className="num">{g.callWall !== null ? `$${g.callWall}` : "—"}</td>
                <td className={`num ${g.netGex >= 0 ? "pos" : "neg"}`}>{big(g.netGex)}</td><td className="small muted">{g.asOf}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>

      <section className="card section">
        <h2>Futures positioning (CFTC Commitments of Traders)</h2>
        <p className="small muted">Speculators&apos; net position (leveraged funds for financial futures, managed money for commodities) as a percentile of the last 3 years. The tag gives the side and the extreme apart ("net short, least short in 3 years"); "crowded" is said only when the two agree (net long at its most long, net short at its most short). Published Fridays 3:30 PM ET with positions as of the Tuesday before.{cot.updatedAt ? ` Read ${fmtEtAgo(cot.updatedAt)}.` : ""}{cot.error && !cot.data ? <span className="warn"> Could not read the CFTC: {cot.error}</span> : null}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Market</th><th>Who</th><th className="num">Net contracts</th><th className="num">% of open interest</th><th>3-year percentile</th><th className="num">Week change</th><th className="small">As of</th><th className="small">Traded through</th></tr></thead>
          <tbody>{rows.map((r) => {
            const m = COT_MARKETS.find((x) => x.key === r.key);
            const pct = r.index3y ?? 50;
            return (
              <tr key={r.key}>
                <td>{r.name}{(r.label ?? r.crowd) && <div><span className={`tag ${r.crowd ? (r.crowd === "crowded long" ? "ok" : "neg") : ""}`}>{r.crowd ? `${r.crowd}: ` : ""}{r.label ?? ""}</span></div>}</td>
                <td className="small">{r.who}</td>
                <td className={`num ${r.net >= 0 ? "pos" : "neg"}`}>{r.net.toLocaleString("en-US")}</td>
                <td className="num">{r.netPctOi !== null ? `${r.netPctOi}%` : "—"}</td>
                <td><div className="cot-bar" title={`${r.index3y ?? "?"}th percentile of ${r.weeks} weeks`}><span style={{ left: `${pct}%` }} /></div><span className="small muted">{r.index3y !== null ? `${r.index3y}th` : "short history"}</span></td>
                <td className="num small">{r.change1w !== null ? `${r.change1w >= 0 ? "+" : ""}${r.change1w.toLocaleString("en-US")}` : "—"}</td>
                <td className="small muted">{r.date}</td>
                <td className="small">{m?.etfs.slice(0, 4).map((s, k) => <span key={s}>{k ? ", " : ""}<Ticker symbol={s} /></span>)}</td>
              </tr>
            );
          })}{rows.length === 0 && <tr><td colSpan={8} className="small muted">No COT data yet.</td></tr>}</tbody>
        </table></div>
      </section>
      <p className="small muted">Prime-brokerage books (e.g. Goldman&apos;s) are private to their clients and not used. Public stand-ins already in the scout: short interest and days to cover on every card, and insider and Congress buying on Filings and Congress.</p>
    </>
  );
}
