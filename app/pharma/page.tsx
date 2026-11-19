import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { secTickerList } from "@/lib/sources/edgar";
import { fetchFdaCalendar, fetchTrialReadouts, type FdaEvent, type TrialReadout } from "@/lib/sources/pharma";
import * as store from "@/lib/scout/store";
import { daysBetween, fmtEtAgo, toEt } from "@/lib/time";
import ResearchButton from "@/components/ResearchButton";
import CardChips from "@/components/CardChips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtMonth = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
/**
 * Our own tests (QuantConnect, 638 biotech and pharma stocks, 2016-2026, against XBI): buying the stock before, on or
 * after FDA and trial news showed no edge; holding a small biotech through a trial readout lost about 9% a trade.
 */
const HISTORY_FDA = "No edge from the stock alone: in our test of 675 FDA decisions (2016-2026, against the biotech ETF XBI), buying when the date became public and selling the day before averaged −0.3% (small caps −4.2%), and holding through the decision was a coin flip (about 80% approvals at +2% against rejections at −7%). The whole reaction happens on the day, mostly in the opening gap, and approvals in small caps tended to fade about 11% over the next three months.";
const HISTORY_TRIALS = "Holding a small biotech through a trial readout lost money in our test: only about 44% of small-cap readouts were positive (+17% on the day) against failures at −30%, about −9% per trade. Buying after a positive readout did not pay either: the move is done on day one and tended to fade.";
const BRIEF_RULES = `What our own tests found, to weigh before proposing anything: ${HISTORY_FDA} The one edge left is in options, which are usually overpriced before a binary FDA date; say so where it applies, but cards are tracked in shares. So do not promote buying the stock just because a decision is coming, and do not promote holding a small cap through the event; promote only when there is a reason beyond the event itself (a mispriced business either way, a forced seller, the market ignoring a known outcome), and say plainly when the right answer is no trade.`;

const decided = (e: FdaEvent) => !/^pending$/i.test(e.outcome.trim());


/** Biopharma catalysts: FDA decision dates and Phase 3 readouts, with the scout's cards on each stock. */
export default async function PharmaPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const now = new Date();
  const today = toEt(now).date;
  const ua = process.env.SEC_USER_AGENT?.trim();
  const [fda, trials, briefs] = await Promise.all([
    panel<FdaEvent[]>("pharma:fda", 12 * 60, () => fetchFdaCalendar(today), 25_000),
    ua ? panel<TrialReadout[]>("pharma:trials", 24 * 60, async () => fetchTrialReadouts(today, await secTickerList(ua)), 25_000) : Promise.resolve({ data: null, updatedAt: null, error: "SEC_USER_AGENT is not set" }),
    store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]),
  ]);
  const cardsOn = (sym: string | null) => (sym ? briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym)) : []);

  // Upcoming: an exact date from today on, or a month-only date from this month on; decided ones from the last week too.
  const month = today.slice(0, 7);
  const upcoming = (fda.data ?? [])
    .filter((e) => (e.date ? e.date >= today || (decided(e) && daysBetween(e.date, today) <= 7) : (e.month ?? "") >= month))
    .sort((a, b) => (a.date ?? `${a.month}-31`).localeCompare(b.date ?? `${b.month}-31`));
  const byMonth = new Map<string, FdaEvent[]>();
  for (const e of upcoming) { const m = (e.date ?? `${e.month}-01`).slice(0, 7); byMonth.set(m, [...(byMonth.get(m) ?? []), e]); }
  const withCards = upcoming.filter((e) => cardsOn(e.symbol).length).length;
  const readouts = trials.data ?? [];

  return (
    <>
      <h1>Pharma</h1>
      <p className="small secondary">Upcoming biopharma catalysts: FDA decision dates (PDUFA goal dates, advisory committees, label expansions) and company Phase 3 trials finishing in the next six months, with the scout&apos;s cards on each stock. FDA decisions are binary events: big moves either way, and much of the outcome is often priced in by the date. &quot;Research it&quot; checks a catalyst into a card, tracked on paper like any other.</p>

      <section className="card section">
        <h2>FDA decisions</h2>
        <div className="history-note small"><b>What history says:</b> {HISTORY_FDA} The one edge left is in options, which tend to be overpriced before decision dates.</div>
        <p className="small muted">{upcoming.length} upcoming{withCards ? `, ${withCards} on stocks with a scout card` : ""}. From RTTNews&apos; FDA calendar{fda.updatedAt ? `, read ${fmtEtAgo(fda.updatedAt)}` : ""}; some dates are given only as a month or quarter.{fda.error && !fda.data ? <span className="warn"> Could not read the calendar: {fda.error}</span> : null}</p>
        {[...byMonth.entries()].map(([m, evs]) => (
          <div key={m} style={{ marginTop: 10 }}>
            <h3 style={{ margin: "6px 0" }}>{fmtMonth(m)}</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Date</th><th>Company</th><th>Drug and decision</th><th>Scout</th></tr></thead>
              <tbody>{evs.map((e, i) => {
                const cards = cardsOn(e.symbol);
                const days = e.date ? daysBetween(today, e.date) : null;
                return (
                  <tr key={`${e.company}-${e.drug}-${i}`} className={cards.length ? "pharma-has-card" : ""}>
                    <td className="small" style={{ whiteSpace: "nowrap" }}>{e.date ? <><b>{fmtDay(e.date)}</b><div className="muted">{days === 0 ? "today" : days! > 0 ? `in ${days} days` : `${-days!} days ago`}</div></> : <><b>{e.when}</b><div className="muted">date not exact</div></>}</td>
                    <td>{e.symbol ? <Ticker symbol={e.symbol} /> : null} <span className="small">{e.company}</span>{e.otherSymbols.length ? <div className="small muted">{e.otherSymbols.join(", ")}</div> : null}</td>
                    <td className="small"><b>{e.drug}</b> · {e.event}{e.status ? <> <span className="tag">{e.status}</span></> : null}{decided(e) ? <div className={/declin|reject|complete response|\bCRL\b|not approv/i.test(e.outcome) ? "neg" : /approv/i.test(e.outcome) ? "pos" : "warn"}>{e.outcome}</div> : null}{e.note ? <details><summary className="muted">review history</summary>{e.note}</details> : null}{e.detailUrl ? <> <a href={e.detailUrl} target="_blank" rel="noreferrer">details</a></> : null}</td>
                    <td className="small">{cards.length ? <CardChips cards={cards} /> : e.symbol && !decided(e) ? <ResearchButton symbol={e.symbol} term={`${e.symbol} FDA ${e.when}: ${e.drug}`.slice(0, 80)} observation={`Upcoming FDA catalyst: ${e.company} (${e.symbol}), ${e.drug}. ${e.event}. Expected ${e.when}${e.status ? `; ${e.status.trim()}` : ""}. Research whether there is a trade into or around this decision: what the market already prices (the stock's move, options-implied move), the approval odds from the data and the FDA's history in this indication, the size of the drug for this company, and what happens on approval versus a rejection or delay. ${BRIEF_RULES}`} /> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </div>
        ))}
        {upcoming.length === 0 && <p className="small muted">No upcoming FDA dates on file{fda.error ? "" : " yet"}.</p>}
      </section>

      <section className="card section">
        <details open={readouts.length <= 40}>
          <summary><h2 style={{ display: "inline" }}>Phase 3 trials finishing soon</h2> <span className="small muted">{readouts.length} on US-listed companies</span></summary>
          <div className="history-note small"><b>What history says:</b> {HISTORY_TRIALS}</div>
          <p className="small muted">Company-sponsored Phase 3 trials whose primary completion (the last main measurement) falls in the next six months, from ClinicalTrials.gov, matched to US tickers by company name. Results usually come weeks to months after this date, and the date itself often slips.{trials.updatedAt ? ` Read ${fmtEtAgo(trials.updatedAt)}.` : ""}{trials.error && !trials.data ? <span className="warn"> {trials.error}</span> : null}</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Primary completion</th><th>Company</th><th>Trial</th><th>Scout</th></tr></thead>
            <tbody>{readouts.slice(0, 300).map((t) => {
              const cards = cardsOn(t.symbol);
              return (
                <tr key={t.nct} className={cards.length ? "pharma-has-card" : ""}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{t.completion}</td>
                  <td><Ticker symbol={t.symbol} /> <span className="small">{t.sponsor}</span></td>
                  <td className="small">{t.drugs.length ? <b>{t.drugs.join(", ")}</b> : null} {t.conditions.slice(0, 2).join(", ")} <span className="muted">· {t.phase}</span> · <a href={`https://clinicaltrials.gov/study/${t.nct}`} target="_blank" rel="noreferrer">{t.nct}</a></td>
                  <td className="small">{cards.length ? <CardChips cards={cards} /> : <span className="muted">—</span>}</td>
                </tr>
              );
            })}{readouts.length === 0 && <tr><td colSpan={4} className="small muted">No readouts on file yet.</td></tr>}</tbody>
          </table></div>
        </details>
      </section>
    </>
  );
}
