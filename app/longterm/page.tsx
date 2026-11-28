import AutoRefresh from "@/components/AutoRefresh";
import CardChips from "@/components/CardChips";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { CHECK_ABOUT, CHECK_LABEL, CHECK_ORDER, firstTradingDayOfJanuary, keptLists, listChanges, LONG_TERM, longTermRows, longTermUniverse, priceOf, readState, REMOVED_SECTORS, screen, SECTOR_CODES, type KeptList, type LongTermRow } from "@/lib/scout/long-term";
import * as store from "@/lib/scout/store";
import { fmtEt, fmtEtAgo, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x}%`);
const money = (x: number | null | undefined, currency?: string | null) => {
  if (x === null || x === undefined) return "—";
  const a = Math.abs(x), unit = currency && currency !== "USD" ? `${currency} ` : "$";
  return `${x < 0 ? "−" : ""}${unit}${a >= 1e12 ? `${(a / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : `${(a / 1e6).toFixed(0)}M`}`;
};
const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Long-term debt against equity as shown: a figure, "none" only for a reported zero, a ceiling when there is no debt line, or "not found". */
function Debt({ r }: { r: LongTermRow }) {
  const m = r.metrics!, why = r.checks.find((c) => c.id === "debt")?.detail ?? "";
  if (m.debt !== null && m.debt !== undefined && m.debtToEquity !== null) return <span title={why} style={{ cursor: "help" }}>{m.debt === 0 ? "none" : m.debtToEquity < 0.005 ? "under 1%" : `${Math.round(m.debtToEquity * 100)}%`}</span>;
  if (m.debtCeiling !== null && m.debtCeiling !== undefined) return <span title={why} style={{ cursor: "help" }}>at most {Math.round(m.debtCeiling * 100)}%<div className="small muted">no debt line</div></span>;
  return <span className="neg" title={why} style={{ cursor: "help" }}>not found</span>;
}

function Table({ rows, prices, cardsOn, weight }: { rows: LongTermRow[]; prices: Record<string, { price: number }>; cardsOn: (s: string) => store.CardBrief[]; weight?: number }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr>
        <th className="num">#</th><th>Stock</th>
        <th className="num" title={CHECK_ABOUT.roe_5y}>Return on equity, 5-year average</th>
        <th className="num" title={CHECK_ABOUT.roe_last}>Last year</th>
        <th className="num" title={`${CHECK_ABOUT.margin} Under it, operating income for the same year; "one-off gain?" marks a profit that operations do not explain.`}>Net margin · operating income</th>
        <th className="num" title={CHECK_ABOUT.debt}>Long-term debt ÷ equity</th>
        <th className="num" title={CHECK_ABOUT.growth}>Net income, now and five years earlier</th>
        <th className="num">Price</th>
        <th className="num" title="The share price times the fiscal year's average diluted share count, divided by that year's net income. For information: it is not part of the screen.">Price ÷ last fiscal year&apos;s earnings</th>
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
            <td><Ticker symbol={r.symbol} /> <div className="small muted">{[r.name, m.industry, r.rank ? `#${r.rank} on the SEC's size list` : null, `fiscal year to ${m.lastYear}`].filter(Boolean).join(" · ")}</div>{Date.parse(r.computedAt) - Date.parse(m.lastYear) > 548 * 86400_000 && <span className="tag warn" title="The latest annual report in the SEC's data for this company is more than 18 months old, so these figures are older than the others'." style={{ cursor: "help" }}>figures from fiscal {m.lastYear.slice(0, 4)}</span>}</td>
            <td className="num"><b>{pct(m.roe5y)}</b></td>
            <td className="num">{pct(m.roeLast)}</td>
            <td className="num">{pct(m.margin)}<div className="small muted">{m.operatingIncome === null || m.operatingIncome === undefined ? "operating income not reported" : `operating income ${money(m.operatingIncome, m.currency)}`}</div>{m.oneOff?.length > 0 && <span className="tag warn" title={m.oneOff.join("; ")} style={{ cursor: "help" }}>one-off gain?</span>}</td>
            <td className="num"><Debt r={r} /></td>
            <td className="num">{money(m.netIncome, m.currency)}<div className="small muted">{m.netIncome5yAgo === null ? "" : `${money(m.netIncome5yAgo, m.currency)} in ${m.year5yAgo?.slice(0, 4)}`}</div></td>
            <td className="num">{price === null ? "—" : `$${price.toFixed(2)}`}</td>
            <td className="num">{pe.pe ?? <span className="small muted">— {pe.why}</span>}</td>
            {weight !== undefined && <td className="num">{weight.toFixed(1)}%</td>}
            <td className="small">{cardsOn(r.symbol).length ? <CardChips cards={cardsOn(r.symbol)} max={3} symbol={r.symbol} /> : <span className="muted">none</span>}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

/** Long term: the 1,000 largest US-listed companies through a fixed quality screen; the top 25 by five-year return on equity, kept as a stored list. */
export default async function LongTermPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [all, briefs, universe, lists] = await Promise.all([longTermRows().catch(() => [] as LongTermRow[]), store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]), longTermUniverse().catch(() => []), keptLists().catch(() => [] as KeptList[])]);
  const state = readState(universe, all);
  const s = screen(all);
  const kept = lists[0] ?? null;
  const cardsOn = (sym: string) => briefs.filter((b) => b.primaryTicker === sym || b.tickers.includes(sym));
  // A re-run is compared with the kept list only from a whole read.
  const changes = kept && state.complete ? listChanges(kept.picks, s.top) : null;
  const data = marketDataFromEnv();
  const want = [...new Set([...(kept?.picks ?? []).map((r) => r.symbol), ...(state.complete ? s.passers.map((r) => r.symbol) : [])])];
  const prices = (want.length && data?.getSnapshots ? await data.getSnapshots(want).catch(() => ({})) : {}) as Record<string, { price: number }>;
  const newest = all.map((r) => r.computedAt).sort().at(-1) ?? null;
  const rest = s.passers.slice(LONG_TERM.keep);
  const progress = `${Math.min(s.pool.length, LONG_TERM.pool).toLocaleString("en-US")} of ${LONG_TERM.pool.toLocaleString("en-US")}`;
  const nextYear = Number(toEt(new Date()).date.slice(0, 4)) + 1;
  const byHand = all.filter((r) => r.rank === 0 && r.metrics);
  const c = s.cutoff;
  return (
    <>
      {!state.complete && <AutoRefresh seconds={60} />}
      <h1>Long term</h1>
      <section className="card notice small">
        The {LONG_TERM.pool.toLocaleString("en-US")} largest US-listed companies by market value (foreign companies listed in the US included), share price ${LONG_TERM.minPrice} or more, one share class per company. Removed before the checks: energy, utilities, real estate, basic materials, and companies listed for less than {LONG_TERM.minListedYears} years. Five checks of each company&apos;s own annual reports, all required; a check with a missing input fails. What passes is ranked by five-year average return on equity and the top {LONG_TERM.keep} are kept at equal weight ({(100 / LONG_TERM.keep).toFixed(0)}% each). Checked by code from the SEC&apos;s data. No AI, and nothing is traded.
        <div style={{ marginTop: 6 }}><b>What was tested and what was not.</b> Your 20-year test ran the five checks on the pool with no sector removal and no {LONG_TERM.minListedYears}-year listing rule: re-running every January and resetting to equal weight made 13.1% a year, and leaving the keepers untouched made 14.7% a year (ending with Nvidia at 45% of the portfolio). Those two figures come from that test, without either rule. The sector removal and the {LONG_TERM.minListedYears}-year listing rule as applied here have not been backtested, and nothing on this page measures a return.</div>
        <div className="muted" style={{ marginTop: 6 }}>{state.complete ? `All ${state.total.toLocaleString("en-US")} entries of the SEC's list are read${newest ? `, the latest ${fmtEtAgo(newest)}` : ""}. Each company is read again every ${LONG_TERM.refreshDays} days; the kept list does not change when it is.` : `A read is in progress: ${state.read.toLocaleString("en-US")} of ${state.total.toLocaleString("en-US")} entries of the SEC's list so far (pool ${progress}). This page refreshes each minute.`}</div>
      </section>

      <section className="card">
        {kept ? (
          <>
            <h2>The kept list, set {fmtEt(kept.setAt)} <span className="small muted">({kept.picks.length})</span></h2>
            <p className="small secondary">A stored copy of the top {LONG_TERM.keep} from the whole read finished on that day: the names, their order and the figures are as they stood then, and a later re-read does not touch them. Equal weight: {(100 / Math.max(kept.picks.length, 1)).toFixed(1)}% each. It is set again on the first trading day of January ({longDate(firstTradingDayOfJanuary(nextYear))}). Only the price column is live.</p>
            <Table rows={kept.picks} prices={prices} cardsOn={cardsOn} weight={100 / Math.max(kept.picks.length, 1)} />
          </>
        ) : (
          <>
            <h2>The kept list</h2>
            <p className="small secondary">{state.complete ? "The whole pool has been read under the current rules; the list is being checked before it is set, once, and it then stays until the first trading day of January." : `No list has been set under the current rules yet. A list is only set from a whole read: read in progress, ${progress}.`}</p>
          </>
        )}
      </section>

      <section className="card">
        <h2>What a re-run today would change</h2>
        {!state.complete ? <p className="small secondary">Re-read in progress, {progress}. This is worked out only from a whole read.</p>
          : !kept || !changes ? <p className="small secondary">Nothing to compare with until the list is set.</p>
          : changes.join.length + changes.leave.length === 0 ? <p className="small secondary">Nothing: today&apos;s top {LONG_TERM.keep} are the kept {LONG_TERM.keep}.</p>
          : (
            <>
              <p className="small secondary">The screen keeps reading new annual reports, so today&apos;s top {LONG_TERM.keep} can differ from the kept list. The kept list itself stays as it is until January.</p>
              <p className="small"><b>Would join:</b> {changes.join.length ? changes.join.map((r, i) => <span key={r.symbol}>{i ? ", " : ""}<Ticker symbol={r.symbol} /> <span className="muted">({pct(r.metrics!.roe5y)})</span></span>) : <span className="muted">none</span>}</p>
              <p className="small"><b>Would leave:</b> {changes.leave.length ? changes.leave.map((p, i) => { const now = all.find((x) => x.symbol === p.symbol); const why = !now?.metrics ? "no longer on the SEC's list" : s.passers.some((x) => x.symbol === p.symbol) ? `still passes, now outside the top ${LONG_TERM.keep}` : !s.pool.includes(now) ? "no longer in the pool" : now.removed ? `now counted as ${now.removed}` : `fails: ${CHECK_ORDER.filter((id) => now.checks.find((k) => k.id === id)?.pass !== true).map((id) => CHECK_LABEL[id].toLowerCase()).join("; ") || "price"}`; return <span key={p.symbol}>{i ? ", " : ""}<Ticker symbol={p.symbol} /> <span className="muted">({why})</span></span>; }) : <span className="muted">none</span>}</p>
            </>
          )}
      </section>

      {state.complete && (
        <section className="card">
          <details>
            <summary><b>Also passes all five, outside the top {LONG_TERM.keep}</b> <span className="small muted">({rest.length})</span></summary>
            <p className="small secondary">The next in line by five-year average return on equity, from the readings on file today.</p>
            {rest.length ? <Table rows={rest} prices={prices} cardsOn={cardsOn} /> : <p className="small muted">None.</p>}
          </details>
        </section>
      )}

      <section className="card">
        <h2>How the pool narrows</h2>
        {!state.complete ? <p className="small secondary">Re-read in progress, {progress}. The counts are shown once the whole pool is read.</p> : (
          <>
            <div className="table-wrap"><table>
              <thead><tr><th>Step</th><th className="num">Companies</th></tr></thead>
              <tbody>
                <tr><td>Largest US-listed companies with annual reports at the SEC</td><td className="num">{s.pool.length.toLocaleString("en-US")}</td></tr>
                <tr><td>Removed: share price under ${LONG_TERM.minPrice}</td><td className="num">{s.underPrice.length}</td></tr>
                <tr><td>Removed: {REMOVED_SECTORS.join(", ")}</td><td className="num">{s.removedSector.length}</td></tr>
                <tr><td>Removed: listed for less than {LONG_TERM.minListedYears} years</td><td className="num">{s.young.length}</td></tr>
                <tr><td><b>Put through the five checks</b></td><td className="num"><b>{s.checked}</b></td></tr>
                {CHECK_ORDER.map((id) => <tr key={id}><td title={CHECK_ABOUT[id]} style={{ cursor: "help" }}>Did not pass: {CHECK_LABEL[id].toLowerCase()}</td><td className="num">{s.failed[id]}</td></tr>)}
                <tr><td><b>Pass all five</b></td><td className="num"><b>{s.passers.length}</b></td></tr>
              </tbody>
            </table></div>
            <p className="small muted">A company can miss more than one check, so the misses add up to more than the companies that failed.</p>
            <h3 style={{ marginTop: "1rem" }}>Where the pool is cut</h3>
            <p className="small">Company number {s.pool.length.toLocaleString("en-US")} is <b>{c.last?.symbol}</b> ({c.last?.name}), with a market value of <b>{c.last?.marketValue ? money(c.last.marketValue) : "not computed"}</b>{c.last?.marketValueFrom ? <span className="muted"> ({c.last.marketValueFrom})</span> : null}. Among the last 25 companies of the pool, the {c.computed} with a computed market value run from {money(c.low)} to {money(c.high)}, middle {money(c.mid)}.</p>
            <ul className="small">
              <li><b>How the pool is ordered.</b> By the SEC&apos;s own list of listed companies, which it publishes largest first; the pool is the first {LONG_TERM.pool.toLocaleString("en-US")} on it that file annual reports there and are listed on a US exchange. The SEC does not say which price or share count its order uses.</li>
              <li><b>How market value is calculated here</b> (to check that order, not to make it). The latest trade price when the company was screened, times the share count on the cover of its latest annual or quarterly report; without a current cover count, the fiscal year&apos;s average diluted count. Not computed for the {c.foreignFilers} pool companies that file a foreign annual report (form 20-F): their share count is in home-market shares, and one US-listed share is often several of those or a fraction of one.</li>
              <li><b>What the check shows.</b> {c.outsideAbove.length} companies outside the pool have a computed market value above the middle of the pool&apos;s last 25{c.outsideAbove.length ? <> ({c.outsideAbove.slice(0, 10).map((x) => `${x.symbol} ${money(x.marketValue)}`).join(", ")}{c.outsideAbove.length > 10 ? ", …" : ""})</> : null}, and {c.insideBelowHalf} inside it have one under half of that.</li>
              <li><b>Why another data source cuts differently.</b> This pool counts every company that files annual reports with the SEC and is listed on a US exchange, {c.foreignFilers} foreign annual-report filers included. A source that counts fewer foreign listings reaches further down the size order before it has 1,000, so a company just outside this pool can be inside that one.</li>
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <details>
          <summary><b>The rules, exactly, and where this differs from a data vendor</b></summary>
          <ul className="small">{CHECK_ORDER.map((id) => <li key={id}><b>{CHECK_LABEL[id]}.</b> {CHECK_ABOUT[id]}</li>)}</ul>
          <ul className="small">
            <li><b>A missing input fails the check.</b> If a figure a check needs is not in the company&apos;s filing data, the company fails that check and the reason is shown.</li>
            <li><b>Equity at or below zero.</b> If shareholders&apos; equity is zero or negative in the latest fiscal year, or in any year of the five-year average, the company fails both return-on-equity checks and the debt check.</li>
            <li><b>One-off gain? tag.</b> Shown when net income is more than {LONG_TERM.oneOff.netOverOperating} times operating income for the same year, or when last year&apos;s return on equity is more than {LONG_TERM.oneOff.roeOverAverage} times the five-year average. The company is not removed; you decide.</li>
            <li><b>Listed for {LONG_TERM.minListedYears} years.</b> A company stays when its first annual report in the SEC&apos;s data was filed {LONG_TERM.minListedYears} years or more before the day it was screened, or when its stock was trading in the month up to that {LONG_TERM.minListedYears}-year mark (the SEC&apos;s data starts in 2009, and in 2018 for foreign companies, so an old listing can have a young first report). Otherwise it is removed. A company that came back under a new SEC number and a new symbol inside the {LONG_TERM.minListedYears} years reads as young.</li>
            <li><b>Size order.</b> See &quot;Where the pool is cut&quot; above. Funds, and foreign companies that only trade over the counter, do not count.</li>
            {byHand.length > 0 && <li><b>Added by hand.</b> {byHand.map((r) => `${r.name} (${r.symbol})`).join(", ")}: the SEC&apos;s list, as read, does not carry {byHand.length === 1 ? "it" : "them"} among its largest, though by market value {byHand.length === 1 ? "it belongs" : "they belong"} in the pool. Counted inside the {LONG_TERM.pool.toLocaleString("en-US")}.</li>}
            <li><b>Figures.</b> As the company reported them to the SEC for its fiscal year, in the currency it keeps its accounts in. A company that reports in another currency is compared with itself, so the ratios hold; its price ÷ earnings is left blank, with the reason.</li>
            <li><b>Price.</b> The $5 rule uses the price when the company was screened.</li>
          </ul>
          <p className="small"><b>How the sector removal is decided.</b> By each company&apos;s SEC industry code (shown as the industry under its name), not by a data vendor&apos;s sector label, so a few companies can fall on the other side of a line than in your test. These codes are removed:</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Removed as</th><th>SEC industry codes</th><th>What they cover</th></tr></thead>
            <tbody>{SECTOR_CODES.map((x) => <tr key={`${x.sector}${x.from}`}><td>{x.sector}</td><td style={{ whiteSpace: "nowrap" }}>{x.from === x.to ? x.from : `${x.from}–${x.to}`}</td><td className="small">{x.what}</td></tr>)}</tbody>
          </table></div>
          <p className="small muted">Left in on purpose: drugs (2830s) and soap and cosmetics (2840s) among the chemicals, waste haulers (4950s), homebuilders (1531), paper packaging (2650s), fibre and cable (3357), and retailers of building materials and hardware (5200s, where Fastenal files).</p>
        </details>
      </section>
    </>
  );
}
