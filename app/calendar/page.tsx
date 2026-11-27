import Link from "next/link";
import CardChips from "@/components/CardChips";
import CompanyLogo from "@/components/CompanyLogo";
import Ticker from "@/components/Ticker";
import { chartUrl } from "@/config/links";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { bySlot, rankReports, weekDays, weekMonday, type CalEntry } from "@/lib/scout/earnings-calendar";
import { stSnapshots, type StSnapshot } from "@/lib/scout/st-trending";
import * as store from "@/lib/scout/store";
import { calendarDay, type EarningsReport } from "@/lib/sources/earnings-data";
import { addDays, toEt, type Session } from "@/lib/time";
import PreEarnings from "./PreEarnings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tiles shown per slot before "more". */
const SHOWN = 8;

const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const cap = (x: number | null) => (x === null ? null : x >= 1e12 ? `$${(x / 1e12).toFixed(1)}T` : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`);
const eps = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);

type CardsOn = (symbol: string) => store.CardBrief[];

function Tile({ r, cardsOn }: { r: CalEntry; cardsOn: CardsOn }) {
  const reported = r.epsActual !== null && r.epsEstimate !== null;
  const beat = reported && r.epsActual! >= r.epsEstimate!;
  const cards = [...cardsOn(r.symbol)].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const tip = [r.name, cap(r.marketCap) && `market cap ${cap(r.marketCap)}`, `EPS estimate ${eps(r.epsEstimate)}`, r.lastYearEps !== null && `a year ago ${eps(r.lastYearEps)}`, reported && `reported ${eps(r.epsActual)}`, r.trending && "trending on Stocktwits"].filter(Boolean).join(" · ");
  return (
    <div className={`cal-tile${cards.length ? " carded" : ""}`}>
      <a className="cal-tile-link" href={chartUrl(r.symbol)} target="_blank" rel="noreferrer" title={tip}>
        <span className="cal-logo-box"><CompanyLogo symbol={r.symbol} name={r.name} /></span>
        <span className="cal-sym">{r.symbol}{r.marketCap ? <span className="cal-cap"> · {cap(r.marketCap)}</span> : null}</span>
      </a>
      {(r.trending || reported) && (
        <span className="cal-flags">
          {r.trending && <span className="cal-flag st" title="trending on Stocktwits">ST</span>}
          {reported && <span className={`cal-flag ${beat ? "beat" : "miss"}`}>{beat ? "beat" : "miss"}</span>}
        </span>
      )}
      {cards.length > 0 && (
        <span className="cal-cards">
          {cards.slice(0, 2).map((c) => <a key={c.id} href={`/cards/${c.id}`} className={c.direction} title={`Scout card #${c.id}: ${c.direction} ${c.primaryTicker}, ${c.status.replace("_", " ")}`}>{c.direction === "long" ? "▲" : "▼"}#{c.id}</a>)}
          {cards.length > 2 && <span className="muted">+{cards.length - 2}</span>}
        </span>
      )}
    </div>
  );
}

/** A compact list of the rest; a dot marks a stock with a scout card. */
function MoreList({ rows, cardsOn }: { rows: CalEntry[]; cardsOn: CardsOn }) {
  return <div className="cal-more-list">{rows.map((r) => <a key={r.symbol} href={cardsOn(r.symbol).length ? `/cards/${[...cardsOn(r.symbol)].sort((x, y) => y.id - x.id)[0].id}` : chartUrl(r.symbol)} target={cardsOn(r.symbol).length ? undefined : "_blank"} rel="noreferrer" title={`${r.name}${cap(r.marketCap) ? ` · ${cap(r.marketCap)}` : ""}${cardsOn(r.symbol).length ? " · the scout has a card on it" : ""}`}>{r.symbol}{cardsOn(r.symbol).length ? <span className="cal-dot">●</span> : null}</a>)}</div>;
}

function Slot({ rows, cardsOn }: { rows: CalEntry[]; cardsOn: CardsOn }) {
  const top = rows.slice(0, SHOWN), rest = rows.slice(SHOWN);
  return (
    <div className="cal-slot">
      {top.length === 0 ? <span className="cal-none">—</span> : top.map((r) => <Tile key={r.symbol} r={r} cardsOn={cardsOn} />)}
      {rest.length > 0 && (
        <details className="cal-more">
          <summary>+{rest.length} more</summary>
          <MoreList rows={rest} cardsOn={cardsOn} />
        </details>
      )}
    </div>
  );
}

/** Calendar: the week's earnings reports in the style of a "most anticipated" board. */
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const today = toEt(new Date()).date;
  const want = (await searchParams).week;
  const monday = weekMonday(want && /^\d{4}-\d{2}-\d{2}$/.test(want) ? want : today);
  const days = weekDays(monday);
  const db = hasDatabase();
  const data = marketDataFromEnv();
  const [byDay, snaps, briefs, sessions, pre, preRecord] = await Promise.all([
    Promise.all(days.map((d) => calendarDay(d).catch(() => null))),
    db ? stSnapshots(28).catch(() => [] as StSnapshot[]) : Promise.resolve([] as StSnapshot[]),
    db ? store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]) : Promise.resolve([] as store.CardBrief[]),
    data ? data.getCalendar(days[0], days[4]).catch(() => null) : Promise.resolve(null),
    db ? import("@/lib/scout/pre-earnings").then(({ preEarnings }) => preEarnings(today)).catch(() => null) : Promise.resolve(null),
    db ? import("@/lib/scout/pre-earnings").then(({ preEarningsRecord }) => preEarningsRecord()).catch(() => null) : Promise.resolve(null),
  ]);
  // Market holidays and half days (only when the market calendar loaded).
  const sessionOf = (d: string) => (sessions ? sessions.find((x: Session) => x.date === d) ?? "closed" : null);
  const since = addDays(today, -14);
  const trending = new Set(snaps.filter((s) => s.date >= since).flatMap((s) => s.items.map((i) => i.symbol)));
  const carded = new Set(briefs.flatMap((c) => [c.primaryTicker, ...c.tickers]));
  const cardsOn: CardsOn = (sym) => briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym));
  const failed = byDay.every((d) => d === null);
  // Stocks the scout has cards on that report this week, in date order.
  const mine = byDay.flatMap((d) => d ?? []).filter((r) => cardsOn(r.symbol).length > 0).sort((a, b) => a.reportDate.localeCompare(b.reportDate) || (a.timing === "before_open" ? -1 : 1));
  const total = byDay.reduce((n, d) => n + (d?.length ?? 0), 0);

  return (
    <>
      <div className="cal-nav">
        <Link className="chip" href={`/calendar?week=${addDays(monday, -7)}`}>‹ Previous week</Link>
        <Link className="chip" href="/calendar">This week</Link>
        <Link className="chip" href={`/calendar?week=${addDays(monday, 7)}`}>Next week ›</Link>
      </div>
      <div className="cal-board">
        <header className="cal-head">
          <div className="cal-title">Most Anticipated Earnings Releases</div>
          <div className="cal-sub">for the week beginning</div>
          <div className="cal-week">{longDate(monday)}</div>
          <div className="cal-note">Biggest companies first · {total} reports this week</div>
        </header>
        {failed ? <p className="cal-empty">The earnings calendar could not be loaded right now. Try again in a minute.</p> : (
          <div className="cal-grid">
            {days.map((d, i) => {
              const rows = byDay[i] ?? [];
              const s = bySlot(rows as EarningsReport[]);
              const bo = rankReports(s.before_open, trending, carded), ac = rankReports(s.after_close, trending, carded), tba = rankReports(s.unknown, trending, carded);
              const isFri = i === 4;
              return (
                <section key={d} className={`cal-day${d === today ? " today" : ""}`}>
                  <div className="cal-day-name">{weekday(d)} <span className="cal-day-date">{shortDate(d)}</span></div>
                  {sessionOf(d) === "closed" ? <div className="cal-market">Market closed</div> : (sessionOf(d) as Session | null)?.close && (sessionOf(d) as Session).close < "16:00" ? <div className="cal-market">Market closes {(sessionOf(d) as Session).close.replace(/^13:00$/, "1 PM")}</div> : null}
                  {(bo.length > 0 || ac.length > 0) && (
                    <div className={`cal-day-cols${ac.length === 0 || bo.length === 0 ? " one" : ""}`}>
                      {bo.length > 0 && <div><div className="cal-slot-name">Before Open</div><Slot rows={bo} cardsOn={cardsOn} /></div>}
                      {ac.length > 0 && <div><div className="cal-slot-name">After Close</div><Slot rows={ac} cardsOn={cardsOn} /></div>}
                    </div>
                  )}
                  {tba.length > 0 && (
                    <div className="cal-tba">
                      <div className="cal-slot-name">Time Not Confirmed</div>
                      <div className="cal-tba-tiles">{tba.slice(0, 4).map((r) => <Tile key={r.symbol} r={r} cardsOn={cardsOn} />)}</div>
                      {tba.length > 4 && <details className="cal-more"><summary>+{tba.length - 4} more</summary><MoreList rows={tba.slice(4, 80)} cardsOn={cardsOn} /></details>}
                    </div>
                  )}
                  {rows.length === 0 && <div className="cal-none">No reports listed.</div>}
                </section>
              );
            })}
          </div>
        )}
        <footer className="cal-foot">Data: Nasdaq earnings calendar · logos: Financial Modeling Prep · hover a logo for the estimate · ▲▼ the scout&apos;s cards on the stock (last 6 months)</footer>
      </div>
      {pre && preRecord && <PreEarnings ahead={pre.ahead} past={pre.past} record={preRecord} />}
      {mine.length > 0 && (
        <section className="card">
          <h2>Your cards reporting this week</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Stock</th><th>Estimate</th><th>Cards</th></tr></thead>
            <tbody>{mine.map((r) => <tr key={`${r.reportDate}-${r.symbol}`}><td className="small">{weekday(r.reportDate).slice(0, 3)} {shortDate(r.reportDate)} · {r.timing === "before_open" ? "before open" : r.timing === "after_close" ? "after close" : "time not confirmed"}</td><td><Ticker symbol={r.symbol} /> <span className="small muted">{r.name}{cap(r.marketCap) ? ` · ${cap(r.marketCap)}` : ""}</span></td><td className="small">EPS {eps(r.epsEstimate)}{r.epsActual !== null ? <> · reported {eps(r.epsActual)}</> : null}</td><td><CardChips cards={cardsOn(r.symbol)} max={4} symbol={r.symbol} /></td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
