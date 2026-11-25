import CardChips from "@/components/CardChips";
import ResearchButton from "@/components/ResearchButton";
import Ticker from "@/components/Ticker";
import { letterLine, type FdaLetterWatch } from "@/lib/scout/fda-letters";
import { verdictLabel } from "@/lib/sources/fda-letters";
import type { CardBrief } from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const TONE: Record<string, string> = { clinical: "error", studies: "late", fixable: "ok", unclear: "" };

/** The FDA's own rejection letters: what it actually faulted, next to the stock. */
export default function FdaLetters({ watch, cardsOn }: { watch: FdaLetterWatch | null; cardsOn: (sym: string | null) => CardBrief[] }) {
  const letters = watch?.letters ?? [];
  const listed = letters.filter((l) => l.symbol);
  const count = (v: string) => letters.filter((l) => l.verdict === v).length;
  const row = (l: FdaLetterWatch["letters"][number]) => (
    <tr key={l.key} className={cardsOn(l.symbol).length ? "pharma-has-card" : ""}>
      <td className="small" style={{ whiteSpace: "nowrap" }}>{day(l.date)}</td>
      <td>{l.symbol ? <Ticker symbol={l.symbol} /> : null} <span className="small">{l.company}</span><div className="small muted">{l.application}</div></td>
      <td className="small"><span className={`tag ${TONE[l.verdict]}`}>{verdictLabel(l.verdict)}</span>{l.faults.length ? <div className="muted">{l.faults.join(" · ")}</div> : null}{l.quote ? <details><summary className="muted">the FDA&apos;s words</summary>{l.quote}…</details> : null}</td>
      <td className="small">{cardsOn(l.symbol).length ? <CardChips cards={cardsOn(l.symbol)} /> : l.symbol ? <ResearchButton from={{ label: "Pharma", url: "/pharma#fda-letters" }} symbol={l.symbol} term={`${l.symbol} FDA rejection letter ${l.date}`.slice(0, 80)} observation={`${letterLine(l)} Research whether the stock has priced what the letter says: a rejection over manufacturing or a factory inspection is usually fixed and re-filed within months, while one over the clinical evidence usually needs a new trial. Check what the company told investors against the FDA's own words, how far the stock fell, whether a re-filing or a new decision date has been announced, and the cash it has to get there. Say plainly when there is no trade.`} /> : <span className="muted">—</span>}</td>
    </tr>
  );
  return (
    <section className="card section" id="fda-letters">
      <h2>FDA rejection letters, in the FDA&apos;s own words</h2>
      <p className="small muted">When the FDA declines to approve a drug it sends the company a letter saying why, and since 2025 it publishes those letters, usually within days to a few weeks. The company&apos;s press release is its own telling; this is the FDA&apos;s. The scout reads the letter&apos;s headings (no AI): <b>clinical evidence</b> usually means a new trial, <b>product quality</b> and <b>factory inspection</b> are usually fixed and re-filed within months. {letters.length ? `${letters.length} letters on file for drugs still unapproved: ${count("fixable")} manufacturing or factory, ${count("clinical")} clinical evidence, ${count("studies")} other studies, ${count("unclear")} the scout could not read. ${listed.length} are US-listed companies.` : "Not read yet: the first reading runs within the next few hours."}{watch ? ` Read ${fmtEtAgo(watch.at)}; the FDA last updated its set ${watch.lastUpdated ?? "at a date it did not give"}.` : ""} A new letter on a stock with a card or on your watch-list is pushed to your phone. Source: openFDA.</p>
      {listed.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Letter dated</th><th>Company</th><th>What the FDA faulted</th><th>Scout</th></tr></thead>
          <tbody>{listed.slice(0, 40).map(row)}</tbody>
        </table></div>
      )}
      {letters.length > listed.length && (
        <details className="small"><summary>Letters to companies not listed in the US, or that the scout could not match to a ticker ({letters.length - listed.length})</summary>
          <div className="table-wrap"><table><thead><tr><th>Letter dated</th><th>Company</th><th>What the FDA faulted</th><th>Scout</th></tr></thead><tbody>{letters.filter((l) => !l.symbol).slice(0, 120).map(row)}</tbody></table></div>
        </details>
      )}
    </section>
  );
}
