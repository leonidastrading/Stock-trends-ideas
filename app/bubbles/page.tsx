import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { afterMove, bubbleRows, EVENT_LABEL, type BubbleRow } from "@/lib/scout/bubbles";
import * as store from "@/lib/scout/store";
import Movers from "./Movers";
import { daysBetween, fmtEtAgo, toEt } from "@/lib/time";
import NewSince from "@/components/NewSince";

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null) => (x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}%`);
const LEVEL: Record<string, [string, string]> = { mania: ["mania", "error"], building: ["building", "late"], quiet: ["quiet", ""] };

/** The famous ones (approximate figures): a known date, a run-up into it on retail attention, the top on or near the day. */
const FAMOUS: Array<{ group: string; items: Array<[string, string]> }> = [
  { group: "Crypto", items: [
    ["Bitcoin futures launch, Dec 2017", "Bitcoin ran from about $6,000 to nearly $20,000 in six weeks, peaked the day CME futures began trading, then fell about 65% over two months."],
    ["Coinbase listing, Apr 14, 2021", "Bitcoin hit about $64,000 that day and was near $30,000 by July. Coinbase opened at $381 and did not trade there again for years."],
    ["Dogecoin and SNL, May 8, 2021", "Dogecoin peaked near $0.73 just before Elon Musk hosted, then dropped about 30% during the show."],
    ["Ethereum Merge, Sep 15, 2022", "Ether doubled from the June low into August, then fell about 25% in the week after the upgrade."],
    ["Spot Bitcoin ETFs, Jan 2024", "Bitcoin ran from about $27,000 in October to $49,000 on launch day, then fell about 20% in two weeks (it went on to new highs later)."],
    ["Trump inauguration, Jan 20, 2025", "Bitcoin hit a record near $109,000 that morning and was around $75,000 by April."],
  ] },
  { group: "Stocks", items: [
    ["Canada legalizes cannabis, Oct 17, 2018", "Tilray went from $25 to $300 by September; pot stocks topped days before legalization and lost about half by December."],
    ["Tesla's stock split, Aug 2020", "Up about 80% from the announcement to the split date, then down about a third in the following week."],
    ["Tesla joins the S&P 500, Dec 21, 2020", "Up about 70% from the announcement to the inclusion date, then down 6% on its first day in the index."],
    ["Virgin Galactic, July 11, 2021", "Ran into Richard Branson's flight, then fell 17% the next day when the company announced a share sale."],
    ["Nvidia's 10-for-1 split, June 2024", "Rallied into the split, peaked ten days later, and was down about a third by early August."],
  ] },
];

function observation(r: BubbleRow): string {
  return `Possible "buy the rumor, sell the news" setup: ${r.symbol} into a fixed-date event, ${EVENT_LABEL[r.type]} on ${r.date}: ${r.what}. Measured now: ${pct(r.run30)} in 30 days against SPY ${pct(r.spy30)}; Stocktwits ${r.perHour ?? "?"} messages/hour${r.z !== null ? ` (${r.z > 0 ? "+" : ""}${r.z} sigma vs its normal)` : ""}; crowding stage ${r.stage ?? "?"} of 4. Research whether this is hype that tops on or near the date (buyers already in, nothing left to look forward to after the day) or a move that keeps running. Say what is priced, how crowded it is, what happens after the date (for example a share sale, index buying finishing, a lockup), and the timing risk: shorting before the date can be painful while the run continues, so say when a fade would be entered, if at all.`;
}

/** Bubbles: fixed-date hype ("buy the rumor, sell the news") setups coming up, and how past ones did after the date. */
export default async function BubblesPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const today = toEt(new Date()).date;
  const [rows, briefs] = await Promise.all([bubbleRows(120).catch(() => [] as BubbleRow[]), store.cardBriefsSince(120).catch(() => [] as store.CardBrief[])]);
  const order = { mania: 0, building: 1, quiet: 2 } as const;
  const upcoming = rows.filter((r) => r.date >= today).sort((a, b) => order[a.level] - order[b.level] || a.date.localeCompare(b.date));
  const past = rows.filter((r) => r.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const cardsOn = (s: string) => briefs.filter((c) => c.primaryTicker === s || c.tickers.includes(s));
  // The forward record: of the loud ones whose 10 sessions are done, how many lagged SPY after the date.
  const done = past.filter((r) => r.levelSeen !== "quiet" && afterMove(r) !== null);
  const fell = done.filter((r) => afterMove(r)! < 0).length;

  return (
    <>
      <h1>Bubbles</h1>

      <Movers briefs={briefs} />

      <section className="card">
        <h2>Coming up: dated events</h2>
        <p className="small muted"><span className="tag error">mania</span> up 25+ points more than SPY in 30 days with attention far above its normal (or crowding stage 3+). <span className="tag late">building</span> up 15+ points more than SPY, or stage 3+. Earnings and FDA dates are listed only when building or mania; events found in the news are listed either way.</p>
        {upcoming.length === 0 ? <p className="small muted">Nothing found yet. The first check runs within two hours.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Event</th><th>Date</th><th className="num">30d vs SPY</th><th>Attention</th><th>Hype</th><th>Cards / research</th></tr></thead>
            <tbody>{upcoming.map((r) => {
              const cards = cardsOn(r.symbol);
              const left = daysBetween(today, r.date);
              return (
                <tr key={r.id}>
                  <td><Ticker symbol={r.symbol} /><NewSince tab="bubbles" at={r.firstSeen} /></td>
                  <td className="small"><b>{EVENT_LABEL[r.type]}</b>: {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.what}</a> : r.what} <span className="muted">({r.source})</span></td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.date)}<div className="muted">{left === 0 ? "today" : `in ${left} day${left === 1 ? "" : "s"}`}</div></td>
                  <td className={`num ${r.run30 !== null && r.run30 - (r.spy30 ?? 0) >= 15 ? "warn" : ""}`}>{pct(r.run30)}<div className="small muted">SPY {pct(r.spy30)}</div></td>
                  <td className="small">{r.perHour !== null ? `${r.perHour}/h Stocktwits` : "—"}{r.z !== null ? <div className="muted">{r.z > 0 ? "+" : ""}{r.z}σ vs normal</div> : null}{r.stage !== null ? <div className="muted">stage {r.stage}</div> : null}</td>
                  <td><span className={`tag ${LEVEL[r.level][1]}`}>{LEVEL[r.level][0]}</span></td>
                  <td className="small">{cards.length > 0 && <CardChips cards={cards} max={4} />} <ResearchButton symbol={r.symbol} term={`bubble: ${r.symbol} ${EVENT_LABEL[r.type]} ${r.date}`.slice(0, 80)} observation={observation(r)} kind="event" from={{ label: "Bubbles", url: "/bubbles" }} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h2>After the event date</h2>
        <p className="small muted">What each listed stock did from the event-day close to 10 sessions later, against SPY. {done.length ? <>So far {fell} of {done.length} loud ones (mania or building when first listed) lagged SPY over those 10 sessions.</> : "The record fills in as dates pass."}</p>
        {past.length === 0 ? <p className="small muted">No dates have passed yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Stock</th><th>Event</th><th>Date</th><th>When listed</th><th className="num">Into the date</th><th className="num">5 sessions after</th><th className="num">10 sessions after vs SPY</th></tr></thead>
            <tbody>{past.map((r) => {
              const into = r.priceSeen && r.priceEvent ? (r.priceEvent / r.priceSeen - 1) * 100 : null;
              const a5 = r.priceEvent && r.priceAfter5 ? (r.priceAfter5 / r.priceEvent - 1) * 100 : null;
              const a10 = afterMove(r);
              return (
                <tr key={r.id}>
                  <td><Ticker symbol={r.symbol} /></td>
                  <td className="small"><b>{EVENT_LABEL[r.type]}</b>: {r.what}</td>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.date)}</td>
                  <td><span className={`tag ${LEVEL[r.levelSeen][1]}`}>{LEVEL[r.levelSeen][0]}</span></td>
                  <td className="num">{pct(into)}</td>
                  <td className={`num ${a5 === null ? "muted" : a5 < 0 ? "neg" : "pos"}`}>{pct(a5)}</td>
                  <td className={`num ${a10 === null ? "muted" : a10 < 0 ? "neg" : "pos"}`}>{a10 === null ? "waiting" : pct(a10)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      <details className="card">
        <summary><b>The famous ones</b> <span className="small muted">(approximate figures)</span></summary>
        {FAMOUS.map((g) => (
          <div key={g.group}>
            <h3>{g.group}</h3>
            <ul className="small">{g.items.map(([t, d]) => <li key={t}><b>{t}:</b> {d}</li>)}</ul>
          </div>
        ))}
        <p className="small"><b>What they have in common:</b> a fixed date everyone could see coming, a big run-up fueled by retail attention, and nothing left to look forward to once the day arrived.</p>
      </details>
    </>
  );
}
