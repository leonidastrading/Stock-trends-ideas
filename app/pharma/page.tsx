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
import { panelVoteLabel } from "@/lib/sources/panel-vote";
import { panelStudy } from "@/lib/scout/panel-study";
import { mismatch, panelNoteText, panelWatch, type PanelNote } from "@/lib/scout/panel-watch";
import PanelStudy from "./PanelStudy";
import FdaLetters from "./FdaLetters";
import { fdaLetterWatch } from "@/lib/scout/fda-letters";

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
/**
 * An outside check on our own FDA test, with nearly twice the decisions. Their figures are medians of the raw stock
 * move (not against a benchmark), read from the study page on Nov 25, 2026. Reuse is invited with this attribution.
 */
const PDUFA_BIO = "pdufa.bio, PDUFA run-up study (n=1,130, 2020-01-08 to 2026-11-20)";
const HISTORY_OUTSIDE = `An outside study of 1,130 FDA decisions agrees (${PDUFA_BIO}; medians, raw moves): 87% were approvals, the typical stock rose 4.4% over the 120 trading days before the date and moved -0.1% on the day and about nothing over the next five, and companies of $50M to $300M drifted -0.8% into the date. The typical size of the decision-day move, either way, was 8.6% for companies under $50M, 4.1% for $50M to $300M, 3.6% for $300M to $2B, 2.4% for $2B to $10B and 1.0% above that. So the usual decision is an approval that barely moves the stock, and the big moves are a long tail of surprises.`;

/** The panel-vote look-back as first priced on Nov 24, 2026 (the live table on this page is the current one). */
const HISTORY_PANEL = "An advisory panel's vote predicts the FDA but is not a trade by itself: in our look-back of 36 votes on small and mid caps since 2019, the FDA rejected 14 of 17 drugs the panel voted against and approved 14 of 17 it voted for, yet the stock moved at once (about -34% on a negative vote before anyone could act), and shorting from the next open to the decision then beat the biotech ETF only half the time and lost 26% on average, because the three approvals and the rebounds cost far more than the rejections paid. Going long after a positive vote was no better (47% beat the ETF). So a panel vote is evidence about the outcome, not a reason to trade; it matters most when the crowd has since talked itself out of it, and then only with defined risk.";
const BRIEF_RULES = `What our own tests found, to weigh before proposing anything: ${HISTORY_FDA} ${HISTORY_OUTSIDE} ${HISTORY_PANEL} The one edge left is in options, which are usually overpriced before a binary FDA date; say so where it applies, but cards are tracked in shares. So do not promote buying the stock just because a decision is coming, and do not promote holding a small cap through the event; promote only when there is a reason beyond the event itself (a mispriced business either way, a forced seller, the market ignoring a known outcome), and say plainly when the right answer is no trade.`;

/** The advisory panel's vote on a pending decision, from the company's latest 10-Q or 10-K, with the crowd beside it. */
function PanelChip({ n }: { n: PanelNote | undefined }) {
  if (!n?.vote) return null;
  const m = mismatch(n);
  return (
    <div style={{ marginTop: 3 }}>
      <span className={`tag ${n.vote.side === "negative" ? "error" : n.vote.side === "positive" ? "ok" : "late"}`} title={n.vote.sentence}>Panel voted {panelVoteLabel(n.vote)}{n.vote.said ? `, ${new Date(`${n.vote.said}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}</span>
      {n.bullishPct !== null ? <span className="muted"> · crowd {n.bullishPct}% bullish</span> : null}
      {n.filing ? <> · <a href={n.filing.url} target="_blank" rel="noreferrer">{n.filing.form} {n.filing.filed}</a></> : null}
      {m ? <div className="warn"><b>⚠ Mismatch:</b> {m}.</div> : null}
    </div>
  );
}

const decided = (e: FdaEvent) => !/^pending$/i.test(e.outcome.trim());


/** Biopharma catalysts: FDA decision dates and Phase 3 readouts, with the scout's cards on each stock. */
const STATUS_CLASS: Record<string, string> = { "final response": "ok", "interim response": "late", "no response yet": "error" };

/** FDA citizen petitions (regulations.gov): short sellers' petitions with their status, and the last 30 days' petitions. */
async function Petitions({ cardsOn }: { cardsOn: (sym: string | null) => store.CardBrief[] }) {
  const w = (await store.cacheGet<import("@/lib/scout/petitions").PetitionWatch>("regs:petitions").catch(() => null))?.data ?? null;
  const row = (p: import("@/lib/sources/regulations").Petition) => (
    <tr key={p.docketId}>
      <td><a href={p.url} target="_blank" rel="noreferrer">{p.docketId}</a><div className="small muted">{p.petitioner}</div></td>
      <td className="small">{p.request ?? <span className="muted">(request not read)</span>}</td>
      <td className="small">{p.filed}</td>
      <td className="small"><span className={`tag ${STATUS_CLASS[p.status] ?? ""}`}>{p.status}</span>{p.statusDate ? <div className="muted">{p.statusDate}</div> : null}{p.past180 ? <div className="warn">open {p.daysOpen} days (past 180)</div> : null}</td>
      <td className="small">{p.symbols.length ? p.symbols.map((s) => <span key={s} style={{ marginRight: 6 }}><Ticker symbol={s} /> <CardChips cards={cardsOn(s)} max={3} symbol={s} /></span>) : <span className="muted">—</span>}</td>
    </tr>
  );
  const recent = (w?.recent ?? []).filter((p) => !w?.shortSellers.some((s) => s.docketId === p.docketId));
  return (
    <section className="card section" id="petitions">
      <h2>FDA citizen petitions (regulations.gov)</h2>
      <p className="small muted">Anyone can ask the FDA to act on a drug or device (pull it, add a warning, refuse approval). Short sellers do it to press a thesis: Scorpion Capital has filed against Harmony (pitolisant), TransMedics and Soleno. The FDA must answer within 180 days (21 CFR 10.30), but an interim &quot;still reviewing&quot; letter counts, so petitions often stay open for years. Checked every 6 hours (short sellers&apos; weekly){w ? `, last ${fmtEtAgo(w.at)}` : ""}; a new petition on a card stock or by a short seller, and a response to one, is pushed to your phone.{w?.error ? <span className="warn"> {w.error}</span> : null}</p>
      {!w && <p className="small muted">Not read yet: the watch runs within the next few minutes.</p>}
      {w && w.shortSellers.length > 0 && <><h3>Filed by short sellers</h3><div className="table-wrap"><table><thead><tr><th>Docket</th><th>What it asks</th><th>Filed</th><th>FDA status</th><th>Stocks</th></tr></thead><tbody>{w.shortSellers.map(row)}</tbody></table></div></>}
      {w && <details className="small" open={recent.some((p) => p.symbols.length > 0)}><summary>All FDA citizen petitions in the last 30 days ({recent.length}{recent.some((p) => p.symbols.length) ? `, ${recent.filter((p) => p.symbols.length).length} on stocks the scout knows` : ""})</summary><div className="table-wrap"><table><thead><tr><th>Docket</th><th>What it asks</th><th>Filed</th><th>FDA status</th><th>Stocks</th></tr></thead><tbody>{recent.slice().sort((a, b) => b.symbols.length - a.symbols.length || b.filed.localeCompare(a.filed)).map(row)}</tbody></table></div></details>}
    </section>
  );
}

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
  const [study, watch, letters] = await Promise.all([panelStudy(), panelWatch(), fdaLetterWatch()]);
  const panelOn = (sym: string | null) => (sym ? watch.notes[sym] : undefined);
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

      <Petitions cardsOn={cardsOn} />

      <section className="card section">
        <h2>FDA decisions</h2>
        <div className="history-note small"><b>What history says:</b> {HISTORY_FDA} The one edge left is in options, which tend to be overpriced before decision dates.<br /><b>An outside check:</b> {HISTORY_OUTSIDE} <a href="https://pdufa.bio" target="_blank" rel="noreferrer">pdufa.bio</a><br /><b>On panel votes:</b> {HISTORY_PANEL} <a href="#panel-votes">The table is below.</a></div>
        <p className="small muted">{upcoming.length} upcoming{withCards ? `, ${withCards} on stocks with a scout card` : ""}{(() => { const v = upcoming.filter((e) => !decided(e) && panelOn(e.symbol)?.vote).length; const read = upcoming.filter((e) => !decided(e) && panelOn(e.symbol)).length; return read ? `, ${v} with an advisory panel vote on file (${read} companies' latest reports read${watch.at ? `, ${fmtEtAgo(watch.at)}` : ""})` : ""; })()}. From RTTNews&apos; FDA calendar{fda.updatedAt ? `, read ${fmtEtAgo(fda.updatedAt)}` : ""}; some dates are given only as a month or quarter.{fda.error && !fda.data ? <span className="warn"> Could not read the calendar: {fda.error}</span> : null}</p>
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
                    <td className="small"><b>{e.drug}</b> · {e.event}{e.status ? <> <span className="tag">{e.status}</span></> : null}{decided(e) ? <div className={/declin|reject|complete response|\bCRL\b|not approv/i.test(e.outcome) ? "neg" : /approv/i.test(e.outcome) ? "pos" : "warn"}>{e.outcome}</div> : null}{e.note ? <details><summary className="muted">review history</summary>{e.note}</details> : null}{e.detailUrl ? <> <a href={e.detailUrl} target="_blank" rel="noreferrer">details</a></> : null}{decided(e) ? null : <PanelChip n={panelOn(e.symbol)} />}</td>
                    <td className="small">{cards.length ? <CardChips cards={cards} /> : e.symbol && !decided(e) ? <ResearchButton from={{ label: "Pharma", url: e.detailUrl ?? "/pharma" }} symbol={e.symbol} term={`${e.symbol} FDA ${e.when}: ${e.drug}`.slice(0, 80)} observation={`Upcoming FDA catalyst: ${e.company} (${e.symbol}), ${e.drug}. ${e.event}. Expected ${e.when}${e.status ? `; ${e.status.trim()}` : ""}. Research whether there is a trade into or around this decision: what the market already prices (the stock's move, options-implied move), the approval odds from the data and the FDA's history in this indication, the size of the drug for this company, and what happens on approval versus a rejection or delay. ${(() => { const n = panelOn(e.symbol); const t = n ? panelNoteText(n) : null; return t ? `${t} ` : ""; })()}${BRIEF_RULES}`} /> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </div>
        ))}
        {upcoming.length === 0 && <p className="small muted">No upcoming FDA dates on file{fda.error ? "" : " yet"}.</p>}
      </section>

      <FdaLetters watch={letters} cardsOn={cardsOn} />

      <PanelStudy state={study} />

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
