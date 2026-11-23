import Link from "next/link";
import CompanyLogo from "@/components/CompanyLogo";
import { chartUrl } from "@/config/links";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { bySlot, rankReports, weekDays, weekMonday, type CalEntry } from "@/lib/scout/earnings-calendar";
import { stSnapshots, type StSnapshot } from "@/lib/scout/st-trending";
import * as store from "@/lib/scout/store";
import { calendarDay, type EarningsReport } from "@/lib/sources/earnings-data";
import { addDays, toEt, type Session } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Tiles shown per slot before "more". */
const SHOWN = 8;

const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const cap = (x: number | null) => (x === null ? null : x >= 1e12 ? `$${(x / 1e12).toFixed(1)}T` : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`);
const eps = (x: number | null) => (x === null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);

function Tile({ r }: { r: CalEntry }) {
  const reported = r.epsActual !== null && r.epsEstimate !== null;
  const beat = reported && r.epsActual! >= r.epsEstimate!;
  const tip = [r.name, cap(r.marketCap) && `market cap ${cap(r.marketCap)}`, `EPS estimate ${eps(r.epsEstimate)}`, r.lastYearEps !== null && `a year ago ${eps(r.lastYearEps)}`, reported && `reported ${eps(r.epsActual)}`, r.trending && "trending on Stocktwits", r.hasCard && "the scout has a card on it"].filter(Boolean).join(" · ");
  return (
    <a className={`cal-tile${r.hasCard ? " carded" : ""}`} href={chartUrl(r.symbol)} target="_blank" rel="noreferrer" title={tip}>
      <span className="cal-logo-box"><CompanyLogo symbol={r.symbol} name={r.name} /></span>
      <span className="cal-sym">{r.symbol}</span>
      {(r.trending || reported) && (
        <span className="cal-flags">
          {r.trending && <span className="cal-flag st">ST</span>}
          {reported && <span className={`cal-flag ${beat ? "beat" : "miss"}`}>{beat ? "beat" : "miss"}</span>}
        </span>
      )}
    </a>
  );
}

function Slot({ rows }: { rows: CalEntry[] }) {
  const top = rows.slice(0, SHOWN), rest = rows.slice(SHOWN);
  return (
    <div className="cal-slot">
      {top.length === 0 ? <span className="cal-none">—</span> : top.map((r) => <Tile key={r.symbol} r={r} />)}
      {rest.length > 0 && (
        <details className="cal-more">
          <summary>+{rest.length} more</summary>
          <div className="cal-more-list">{rest.map((r) => <a key={r.symbol} href={chartUrl(r.symbol)} target="_blank" rel="noreferrer" title={`${r.name}${cap(r.marketCap) ? ` · ${cap(r.marketCap)}` : ""}`}>{r.symbol}</a>)}</div>
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
  const [byDay, snaps, briefs, sessions] = await Promise.all([
    Promise.all(days.map((d) => calendarDay(d).catch(() => null))),
    db ? stSnapshots(28).catch(() => [] as StSnapshot[]) : Promise.resolve([] as StSnapshot[]),
    db ? store.cardBriefsSince(60).catch(() => [] as store.CardBrief[]) : Promise.resolve([] as store.CardBrief[]),
    data ? data.getCalendar(days[0], days[4]).catch(() => null) : Promise.resolve(null),
  ]);
  // Market holidays and half days (only when the market calendar loaded).
  const sessionOf = (d: string) => (sessions ? sessions.find((x: Session) => x.date === d) ?? "closed" : null);
  const since = addDays(today, -14);
  const trending = new Set(snaps.filter((s) => s.date >= since).flatMap((s) => s.items.map((i) => i.symbol)));
  const carded = new Set(briefs.flatMap((c) => [c.primaryTicker, ...c.tickers]));
  const failed = byDay.every((d) => d === null);
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
          <div className="cal-note">Ranked by company size, lifted when the stock is trending on Stocktwits or the scout has a card on it · {total} reports this week</div>
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
                  <div className={`cal-day-cols${isFri && ac.length === 0 ? " one" : ""}`}>
                    <div><div className="cal-slot-name">Before Open</div><Slot rows={bo} /></div>
                    {!(isFri && ac.length === 0) && <div><div className="cal-slot-name">After Close</div><Slot rows={ac} /></div>}
                  </div>
                  {tba.length > 0 && (
                    <div className="cal-tba">
                      <div className="cal-slot-name">Time Not Confirmed</div>
                      <div className="cal-tba-tiles">{tba.slice(0, 4).map((r) => <Tile key={r.symbol} r={r} />)}</div>
                      {tba.length > 4 && <details className="cal-more"><summary>+{tba.length - 4} more</summary><div className="cal-more-list">{tba.slice(4, 80).map((r) => <a key={r.symbol} href={chartUrl(r.symbol)} target="_blank" rel="noreferrer" title={`${r.name}${cap(r.marketCap) ? ` · ${cap(r.marketCap)}` : ""}`}>{r.symbol}</a>)}</div></details>}
                    </div>
                  )}
                  {rows.length === 0 && <div className="cal-none">No reports listed.</div>}
                </section>
              );
            })}
          </div>
        )}
        <footer className="cal-foot">Data: Nasdaq earnings calendar · logos: Financial Modeling Prep · hover a logo for the estimate · a ring marks a stock the scout has a card on</footer>
      </div>
    </>
  );
}
