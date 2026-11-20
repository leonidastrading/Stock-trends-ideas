import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import Pager, { paginate } from "@/components/Pager";
import { hasDatabase } from "@/lib/db";
import { panel } from "@/lib/market/panels";
import { secTickerList } from "@/lib/sources/edgar";
import { fetchClassActions, fetchItcNotices, type ClassActionCase, type ItcNotice } from "@/lib/sources/court";
import * as store from "@/lib/scout/store";
import { dayAgo, fmtEtAgo, toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const fmtDay = (d: string) => `${new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} (${dayAgo(d)})`;
const PAGE = 25;

/** What the research step is told before proposing anything from a lawsuit. */
const CLASS_RULES = "A securities class action is usually filed after the stock has already fallen on the bad news it describes; the filing itself rarely moves the stock again, and a dozen law firms announcing the same case is marketing, not new information. Look for what is new: facts in the complaint the market has not seen (a whistleblower, internal documents, an SEC or DOJ inquiry), a ruling on the motion to dismiss (a dismissal can lift the stock), or a settlement large against the company's cash. Say plainly when the right answer is no trade.";
const ITC_RULES = "An ITC Section 337 case can end in an exclusion order banning imports of the infringing product into the US (and a cease-and-desist order). Most cases settle or are withdrawn; the ones that matter are where the accused product is a large share of the respondent's US sales and there is no easy design-around, or where the complainant is small enough that a win or a licence moves it. Check the stage (complaint, institution, initial determination, final determination, the 60-day presidential review) and its dates.";

const STAGE_CLASS: Record<string, string> = { "exclusion order": "error", "final ruling": "error", "initial ruling": "late", review: "late", instituted: "", complaint: "", ended: "ok", other: "" };

/** Court: lawsuits that can move listed stocks, with the scout's cards on each. */
export default async function CourtPage({ searchParams }: { searchParams: Promise<{ p?: string; all?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const today = toEt(new Date()).date;
  const ua = process.env.SEC_USER_AGENT?.trim();
  const companies = ua ? secTickerList(ua).catch(() => []) : Promise.resolve([]);
  const noUa = { data: null, updatedAt: null, error: "SEC_USER_AGENT is not set" };
  const [classes, itc, briefs] = await Promise.all([
    ua ? panel<ClassActionCase[]>("court:class-actions", 3 * 60, async () => fetchClassActions(await companies), 25_000) : Promise.resolve(noUa),
    ua ? panel<ItcNotice[]>("court:itc", 12 * 60, async () => fetchItcNotices(today, await companies, undefined, 40), 45_000) : Promise.resolve(noUa),
    store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]),
  ]);
  const cardsOn = (sym: string) => briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym));
  const cases = classes.data ?? [];
  const page = paginate(cases, Number(sp.p ?? 1), PAGE);
  const notices = itc.data ?? [];
  const listed = notices.filter((n) => n.complainantTickers.length || n.respondentTickers.length);
  const shownItc = sp.all === "1" ? notices : listed;

  return (
    <>
      <h1>Court</h1>
      <p className="small secondary">Lawsuits that can move a listed stock, from free public sources, with the scout&apos;s cards on each stock. These are leads, not signals: &quot;Research it&quot; checks one into a card, tracked on paper like any other. Federal court dockets (patent verdicts, antitrust, mass-injury trials, bankruptcy) need a free CourtListener API key and are not read yet.</p>

      <section className="card section" id="class-actions">
        <h2>Securities class actions</h2>
        <div className="history-note small"><b>Worth knowing:</b> these are filed after a stock has already fallen, and a dozen law firms announcing the same case is marketing, not news. What can still move a stock: new facts in the complaint, a ruling on the motion to dismiss, or a big settlement. The lead-plaintiff deadline is about 60 days after the first notice, so it dates the case.</div>
        <p className="small muted">{cases.length} stocks with a case announced in the last two weeks, from the law firms&apos; &quot;lead plaintiff deadline&quot; releases on Google News, one row per stock{classes.updatedAt ? `, read ${fmtEtAgo(classes.updatedAt)}` : ""}.{classes.error && !classes.data ? <span className="warn"> Could not read them: {classes.error}</span> : null}</p>
        <Pager params={{}} name="p" page={page.page} pages={page.pages} total={page.total} label="stocks" hash="#class-actions" />
        <div className="table-wrap"><table>
          <thead><tr><th>Stock</th><th>Lead plaintiff deadline</th><th>Releases</th><th>Latest</th><th>Scout</th></tr></thead>
          <tbody>{page.items.map((c) => {
            const cards = cardsOn(c.symbol);
            return (
              <tr key={c.symbol} className={cards.length ? "pharma-has-card" : ""}>
                <td><Ticker symbol={c.symbol} /> <span className="small">{c.company}</span></td>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{c.deadline ? fmtDay(c.deadline) : <span className="muted">not given</span>}</td>
                <td className="small" title={c.firms.join(", ")}>{c.releases} from {c.firms.length || "?"} firm{c.firms.length === 1 ? "" : "s"}</td>
                <td className="small">{c.headlines[0] ? <><a href={c.headlines[0].url} target="_blank" rel="noreferrer">{c.headlines[0].headline}</a> <span className="muted">· {fmtEtAgo(c.headlines[0].at)}</span></> : null}</td>
                <td className="small">{cards.length ? <CardChips cards={cards} max={4} /> : <ResearchButton from={{ label: "Court", url: "/court#class-actions" }} symbol={c.symbol} term={`court: class action ${c.symbol}`.slice(0, 80)} observation={`A securities class action has been announced against ${c.company} (${c.symbol}): ${c.releases} law-firm releases in the last two weeks${c.deadline ? `, lead plaintiff deadline ${c.deadline}` : ""}. Latest: "${c.headlines[0]?.headline ?? ""}". Find the complaint's allegations and class period, what the stock did when the bad news came out, and whether anything new (an SEC or DOJ inquiry, a restatement, a whistleblower) is coming. ${CLASS_RULES}`} kind={null} />}</td>
              </tr>
            );
          })}{cases.length === 0 && <tr><td colSpan={5} className="small muted">No cases on file{classes.error ? "" : " yet"}.</td></tr>}</tbody>
        </table></div>
      </section>

      <section className="card section" id="itc">
        <h2>Patent cases at the ITC (import bans)</h2>
        <div className="history-note small"><b>Worth knowing:</b> the US International Trade Commission can ban imports of a product that infringes a patent (Masimo against the Apple Watch is the well-known case). Most cases settle or are withdrawn; the ones that matter are where the accused product is a big share of a company&apos;s US sales, or where a small complainant could win a ban or a licence.</div>
        <p className="small muted">Federal Register notices from the last 90 days (new complaints, new investigations, rulings, exclusion orders), with the parties matched to US-listed companies by name. Subsidiaries are not matched to their parents (Beckman Coulter is Danaher&apos;s, for example).{itc.updatedAt ? ` Read ${fmtEtAgo(itc.updatedAt)}.` : ""}{itc.error && !itc.data ? <span className="warn"> Could not read them: {itc.error}</span> : null} {sp.all === "1" ? <a href="/court#itc">Only cases with a listed company</a> : <a href="/court?all=1#itc">All {notices.length} notices</a>}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Step</th><th>Case</th><th>Brought by</th><th>Against</th><th>Scout</th></tr></thead>
          <tbody>{shownItc.map((n, i) => {
            const syms = [...n.complainantTickers, ...n.respondentTickers];
            const cards = syms.flatMap(cardsOn).filter((c, k, a) => a.findIndex((x) => x.id === c.id) === k);
            const party = (names: string[], ticks: string[]) => <>{ticks.map((t) => <span key={t}><Ticker symbol={t} /> </span>)}<span className="small">{names.slice(0, 3).join("; ")}{names.length > 3 ? ` and ${names.length - 3} more` : ""}</span></>;
            return (
              <tr key={`${n.url}-${i}`} className={cards.length ? "pharma-has-card" : ""}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{fmtDay(n.date)}</td>
                <td className="small"><span className={`tag ${STAGE_CLASS[n.stage] ?? ""}`}>{n.stage}</span></td>
                <td className="small"><a href={n.url} target="_blank" rel="noreferrer">{n.product}</a>{n.investigation ? <span className="muted"> · {n.investigation}</span> : null}</td>
                <td>{party(n.complainants, n.complainantTickers)}</td>
                <td>{party(n.respondents, n.respondentTickers)}</td>
                <td className="small">{cards.length ? <CardChips cards={cards} max={4} /> : syms[0] ? <ResearchButton from={{ label: "Court", url: n.url }} symbol={syms[0]} term={`court: ITC ${n.investigation ?? ""} ${syms[0]}`.slice(0, 80)} observation={`ITC Section 337 patent case (${n.investigation ?? "no number yet"}), ${n.stage} on ${n.date}: ${n.product}. Brought by ${n.complainants.join("; ") || "unknown"}${n.complainantTickers.length ? ` (${n.complainantTickers.join(", ")})` : ""} against ${n.respondents.join("; ") || "unknown"}${n.respondentTickers.length ? ` (${n.respondentTickers.join(", ")})` : ""}. Notice: ${n.url}. Research what the accused product is worth to the respondent, the case's stage and next dates, and what a ban or a settlement would mean for each listed party. ${ITC_RULES}`} kind={null} /> : <span className="muted">—</span>}</td>
              </tr>
            );
          })}{shownItc.length === 0 && <tr><td colSpan={6} className="small muted">{notices.length ? "No case with a US-listed company in the last 90 days." : `No notices on file${itc.error ? "" : " yet"}.`}</td></tr>}</tbody>
        </table></div>
      </section>
    </>
  );
}
