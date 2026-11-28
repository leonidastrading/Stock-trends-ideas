import CardChips from "@/components/CardChips";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { CHECK_ABOUT, CHECK_LABEL, CHECK_ORDER, keptLists, listChanges, LONG_TERM, longTermRows, longTermUniverse, priceOf, REMOVED_SECTORS, screen, type KeptList, type LongTermRow } from "@/lib/scout/long-term";
import * as store from "@/lib/scout/store";
import { fmtEt, fmtEtAgo } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x}%`);
const money = (x: number | null, currency?: string | null) => {
  if (x === null) return "—";
  const a = Math.abs(x), unit = currency && currency !== "USD" ? `${currency} ` : "$";
  return `${x < 0 ? "−" : ""}${unit}${a >= 1e12 ? `${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : `${(a / 1e6).toFixed(0)}M`}`;
};

function Table({ rows, prices, cardsOn, weight }: { rows: LongTermRow[]; prices: Record<string, { price: number }>; cardsOn: (s: string) => store.CardBrief[]; weight?: number }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr>
        <th className="num">#</th><th>Stock</th>
        <th className="num" title={CHECK_ABOUT.roe_5y}>Return on equity, 5-year average</th>
        <th className="num" title={CHECK_ABOUT.roe_last}>Last year</th>
        <th className="num" title={CHECK_ABOUT.margin}>Net margin</th>
        <th className="num" title={CHECK_ABOUT.debt}>Long-term debt ÷ equity</th>
        <th className="num" title={CHECK_ABOUT.growth}>Net income, now and five years earlier</th>
        <th className="num">Price</th>
        <th className="num" title="Market value divided by last fiscal year's net income. For information: it is not part of the screen. Blank for a company that reports in another currency.">Price ÷ earnings</th>
        {weight !== undefined && <th className="num">Weight</th>}
        <th>Scout cards</th>
      </tr></thead>
      <tbody>{rows.map((r, i) => {
        const m = r.metrics!;
        const price = prices[r.symbol]?.price ?? m.price ?? null;
        const pe = priceOf(m, price);
        return (
          <tr key={r.symbol}>
            <td className="num">{i + 1}</td>
            <td><Ticker symbol={r.symbol} /> <div className="small muted">{[r.name, m.industry, r.rank ? `#${r.rank} by size` : null, `fiscal year to ${m.lastYear}`].filter(Boolean).join(" · ")}</div></td>
            <td className="num"><b>{pct(m.roe5y)}</b></td>
            <td className="num">{pct(m.roeLast)}</td>
            <td className="num">{pct(m.margin)}</td>
            <td className="num">{m.debtToEquity === null ? "—" : m.debtToEquity === 0 ? "none" : `${Math.round(m.debtToEquity * 100)}%`}</td>
            <td className="num">{money(m.netIncome, m.currency)}<div className="small muted">{m.netIncome5yAgo === null ? "" : `${money(m.netIncome5yAgo, m.currency)} in ${m.year5yAgo?.slice(0, 4)}`}</div></td>
            <td className="num">{price === null ? "—" : `$${price.toFixed(2)}`}</td>
            <td className="num">{pe ?? <span className="muted">—</span>}</td>
            {weight !== undefined && <td className="num">{weight.toFixed(1)}%</td>}
            <td className="small">{cardsOn(r.symbol).length ? <CardChips cards={cardsOn(r.symbol)} max={3} symbol={r.symbol} /> : <span className="muted">none</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

/** Long term: the 1,000 largest US-listed companies through a fixed quality screen; the top 25 by five-year return on equity. */
export default async function LongTermPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [all, briefs, universe, lists] = await Promise.all([longTermRows().catch(() => [] as LongTermRow[]), store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]), longTermUniverse().catch(() => []), keptLists().catch(() => [] as KeptList[])]);
  const s = screen(all);
  const kept = lists[0] ?? null;
  const cardsOn = (sym: string) => briefs.filter((b) => b.primaryTicker === sym || b.tickers.includes(sym));
  const bySymbol = new Map(all.map((r) => [r.symbol, r]));
  const keptRows = kept ? kept.picks.map((p) => bySymbol.get(p.symbol)).filter((r): r is LongTermRow => !!r?.metrics) : [];
  const changes = kept ? listChanges(kept.picks, s.top) : null;
  const data = marketDataFromEnv();
  const want = [...new Set([...s.passers.map((r) => r.symbol), ...keptRows.map((r) => r.symbol)])];
  const prices = (want.length && data?.getSnapshots ? await data.getSnapshots(want).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const scanning = all.length < universe.length * 0.99;
  const newest = all.map((r) => r.computedAt).sort().at(-1) ?? null;
  const rest = s.passers.slice(LONG_TERM.keep);
  const shown = kept ? keptRows : s.top;
  return (
    <>
      <h1>Long term</h1>
      <section className="card notice small">
        The {LONG_TERM.pool.toLocaleString("en-US")} largest US-listed companies by market value (foreign companies listed in the US included), share price ${LONG_TERM.minPrice} or more, put through five checks of their own annual reports. Energy, utilities, real estate and basic materials are removed. What passes is ranked by five-year average return on equity and the top {LONG_TERM.keep} are kept at equal weight, one share class per company. Checked by code from the SEC&apos;s data. No AI, and nothing is traded.
        <div style={{ marginTop: 6 }}><b>Upkeep, as you tested it:</b> re-run the screen every January, sell what no longer passes and buy what newly passes (about 10 of the 25 changed each year in your test). Resetting everything to equal weight each January made 13.1% a year in that test; leaving the keepers untouched made 14.7% but ended with Nvidia at 45% of the portfolio. Those figures are from your test, not from this page.</div>
        <div className="muted" style={{ marginTop: 6 }}>{scanning ? `Reading the list: ${all.length.toLocaleString("en-US")} of ${universe.length.toLocaleString("en-US")} entries so far (a few hundred every 10 minutes, largest first). The list below is provisional until all are read; it is then kept until January.` : `All ${universe.length.toLocaleString("en-US")} entries read${newest ? `, the latest ${fmtEtAgo(newest)}` : ""}; each company is read again every ${LONG_TERM.refreshDays} days, and everything again each January.`}</div>
      </section>

      <section className="card">
        <h2>{kept ? `The list, kept ${fmtEt(kept.setAt)}` : "The top 25 so far (provisional)"} <span className="small muted">({shown.length})</span></h2>
        <p className="small secondary">{kept ? `Set when the whole pool had been screened, and left alone until the next January re-run. Equal weight: ${(100 / Math.max(shown.length, 1)).toFixed(1)}% each. Figures and prices are the latest on file.` : "Ranked by five-year average return on equity among the companies read so far."}</p>
        {shown.length ? <Table rows={shown} prices={prices} cardsOn={cardsOn} weight={100 / shown.length} /> : <p className="small muted">{all.length ? "No company has passed all five checks yet." : "Nothing screened yet: the first companies appear within 10 minutes of the scheduler's next daytime pass."}</p>}
      </section>

      {kept && changes && (changes.join.length > 0 || changes.leave.length > 0) && (
        <section className="card">
          <h2>What a re-run today would change</h2>
          <p className="small secondary">The screen keeps reading new annual reports, so today&apos;s top {LONG_TERM.keep} can differ from the kept list. Nothing changes in the kept list until January.</p>
          <p className="small"><b>Would join:</b> {changes.join.length ? changes.join.map((r, i) => <span key={r.symbol}>{i ? ", " : ""}<Ticker symbol={r.symbol} /> <span className="muted">({pct(r.metrics!.roe5y)})</span></span>) : <span className="muted">none</span>}</p>
          <p className="small"><b>Would leave:</b> {changes.leave.length ? changes.leave.map((p, i) => { const now = bySymbol.get(p.symbol); const why = !now?.metrics ? "no longer read" : s.passers.some((x) => x.symbol === p.symbol) ? "still passes, now outside the top 25" : now.removed ? `now counted as ${now.removed}` : `fails: ${CHECK_ORDER.filter((id) => now.checks.find((c) => c.id === id)?.pass !== true).map((id) => CHECK_LABEL[id].toLowerCase()).join("; ") || "price or pool"}`; return <span key={p.symbol}>{i ? ", " : ""}<Ticker symbol={p.symbol} /> <span className="muted">({why})</span></span>; }) : <span className="muted">none</span>}</p>
        </section>
      )}

      <section className="card">
        <details>
          <summary><b>Also passes all five, outside the top {LONG_TERM.keep}</b> <span className="small muted">({rest.length})</span></summary>
          <p className="small secondary">The next in line by five-year average return on equity.</p>
          {rest.length ? <Table rows={rest} prices={prices} cardsOn={cardsOn} /> : <p className="small muted">None.</p>}
        </details>
      </section>

      <section className="card">
        <h2>How the pool narrows</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Step</th><th className="num">Companies</th></tr></thead>
          <tbody>
            <tr><td>Largest US-listed companies with annual reports at the SEC{s.pool.length < LONG_TERM.pool ? ` (of ${LONG_TERM.pool.toLocaleString("en-US")}; still reading)` : ""}</td><td className="num">{s.pool.length.toLocaleString("en-US")}</td></tr>
            <tr><td>Removed: share price under ${LONG_TERM.minPrice}</td><td className="num">{s.underPrice.length}</td></tr>
            <tr><td>Removed: {REMOVED_SECTORS.join(", ")}</td><td className="num">{s.removedSector.length}</td></tr>
            <tr><td><b>Put through the five checks</b></td><td className="num"><b>{s.checked}</b></td></tr>
            {CHECK_ORDER.map((id) => <tr key={id}><td title={CHECK_ABOUT[id]} style={{ cursor: "help" }}>Did not pass: {CHECK_LABEL[id].toLowerCase()}</td><td className="num">{s.failed[id]}</td></tr>)}
            <tr><td><b>Pass all five</b></td><td className="num"><b>{s.passers.length}</b></td></tr>
          </tbody>
        </table></div>
        <p className="small muted">A company can miss more than one check, so the misses add up to more than the companies that failed.</p>
      </section>

      <section className="card">
        <details>
          <summary><b>The rules, exactly, and where this differs from a data vendor</b></summary>
          <ul className="small">{CHECK_ORDER.map((id) => <li key={id}><b>{CHECK_LABEL[id]}.</b> {CHECK_ABOUT[id]}</li>)}</ul>
          <ul className="small">
            <li><b>Size order.</b> The SEC&apos;s list of listed companies is ordered by market value; the pool is the first {LONG_TERM.pool.toLocaleString("en-US")} on it that file annual reports there and are listed on a US exchange. Funds and foreign companies that only trade over the counter do not count.</li>
            {all.some((r) => r.rank === 0 && r.metrics) && <li><b>Added by hand.</b> {all.filter((r) => r.rank === 0 && r.metrics).map((r) => `${r.name} (${r.symbol})`).join(", ")}: the SEC&apos;s list, as read, does not carry {all.filter((r) => r.rank === 0 && r.metrics).length === 1 ? "it" : "them"} among its largest, though by market value {all.filter((r) => r.rank === 0 && r.metrics).length === 1 ? "it belongs" : "they belong"} in the pool. Counted inside the 1,000.</li>}
            <li><b>Sectors.</b> Taken from each company&apos;s SEC industry code, not from a vendor&apos;s sector label, so a few companies can fall on the other side of a line than in your test (the industry is shown under each name).</li>
            <li><b>Figures.</b> As the company reported them to the SEC for its fiscal year. A company that reports in another currency is compared with itself, so the ratios hold. A check that cannot be made from what the company reports is not a pass.</li>
            <li><b>Price.</b> The $5 rule uses the price when the company was screened. With no price from the market feed the company stays in the pool.</li>
          </ul>
        </details>
      </section>
    </>
  );
}
