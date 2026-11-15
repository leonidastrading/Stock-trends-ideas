import Pager, { FilterLinks, paginate } from "@/components/Pager";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { hasDatabase } from "@/lib/db";
import { CATEGORIES, recentRumorDocs, rumorsSince } from "@/lib/scout/rumors";
import * as store from "@/lib/scout/store";
import { etLabel } from "@/lib/time";
import RumorDrop from "./RumorDrop";
import RumorResearch from "./RumorResearch";
import RumorInvestigate from "./RumorInvestigate";
import CardAsk from "@/components/CardAsk";
import type { Rumor } from "@/lib/scout/rumors";
import RememberFilters from "@/components/RememberFilters";

/** Pure: a rumor written out in full, for the investigation and the scout's answer. */
function rumorDetails(r: Rumor): string {
  return [
    `UNVERIFIED rumor from ${r.docSource}${r.source ? ` (${r.source})` : ""}, logged ${r.createdAt.slice(0, 10)}: ${r.claim}`,
    r.tickers.length ? `Tickers: ${r.tickers.join(", ")}${r.direction !== "none" ? `; if true: ${r.direction} ${r.tickers[0]}` : ""}.` : "",
    r.timeframe ? `Supposed timing: ${r.timeframe}.` : "",
    r.confirm ? `Would be confirmed by: ${r.confirm}` : "",
    r.quote ? `Quote: "${r.quote}"` : "",
    r.mainstream ? `Mainstream news this week: ${r.mainstream.headlines7d} headline(s) on ${r.tickers.join(", ")}${r.mainstream.matches.length ? `; similar: ${r.mainstream.matches.map((m) => m.headline).join("; ")}` : "; nothing similar"}.` : "",
  ].filter(Boolean).join("\n");
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = 25;
const SPEC = ["", "vague", "loose", "some detail", "specific", "very specific"];

/** Rumors: market-relevant claims from fringe and conspiracy sources, catalogued (never asserted) and checked against the news. */
export default async function RumorsPage({ searchParams }: { searchParams: Promise<{ days?: string; cat?: string; tickers?: string; page?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const cat = (CATEGORIES as readonly string[]).includes(sp.cat ?? "") ? sp.cat! : "";
  const withTickers = sp.tickers === "1";
  const [all, docs, cands, cards] = await Promise.all([rumorsSince(days), recentRumorDocs(15), store.candidatesSince(days + 1), store.cardsSince(days + 1)]);
  const status = new Map(cards.map((c) => [c.id, c.status]));
  // Rumors already checked: their card, from the "rumor: … #id" research term.
  const checked = new Map<number, { cardId: number | null; outcome: string }>();
  for (const c of cands) {
    const id = Number(/^rumor: .*?#(\d+)/.exec(c.term)?.[1]);
    if (id) checked.set(id, { cardId: c.cardId, outcome: c.cardId ? (status.get(c.cardId) ?? "card") : c.outcome });
  }
  const rows = all.filter((r) => (!cat || r.category === cat) && (!withTickers || r.tickers.length > 0));
  const page = paginate(rows, Number(sp.page ?? 1), PAGE);
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), cat: cat || undefined, tickers: withTickers ? "1" : undefined };
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return (
    <>
      <h1>Rumors</h1>
      <RememberFilters keys={["days", "cat", "tickers"]} />
      <p className="small warn">Unverified claims from conspiracy forums and fringe sites. Listed as claims, not facts; nothing here is researched or traded unless you press Check it.</p>
      <details className="card section">
        <summary><b>How this page works</b> <span className="small muted">where rumors come from and what the scout does with them</span></summary>
        <div className="small secondary">
          <p>Three ways in: paste or upload below (text, Markdown, HTML, PDF, CSV or JSON, including Reddit and forum JSON exports and JSON lines); drop files into the <code>rumors/</code> folder of your GitHub inbox repo (read within the hour, or right away with the inbox webhook); or mark a website &quot;for the Rumors tab&quot; in Settings → Your websites (read once a day).</p>
          <p>The scout keeps only claims that could move a listed stock, ETF, sector, commodity or the market if true, and skips hate, harassment, claims about private individuals and anything with no market link. For each it notes the tickers, what it would mean if true, how specific it is, when it supposedly happens, what public evidence would confirm it, and where it came from. Rumors with tickers are checked against the week&apos;s mainstream headlines on those tickers.</p>
          <p><b>Check it</b> sends one rumor to research, told to look for public facts that confirm or refute it and not to promote a trade on the rumor alone. Those cards score as &quot;Scout · rumors (checked)&quot;. Reading a document costs one AI call per 90,000 characters (up to 3), within the daily cap.</p>
        </div>
      </details>
      <RumorDrop />
      {docs.length > 0 && (
        <details className="small" style={{ margin: "0 0 10px" }}>
          <summary>Last documents read ({docs.length})</summary>
          {docs.map((d) => <div key={d.id}>{etLabel(d.receivedAt)} · {d.source} · {d.chars.toLocaleString("en-US")} chars · <b>{d.rumors}</b> rumor{d.rumors === 1 ? "" : "s"}{d.error ? <span className="neg"> · {d.error}</span> : null}</div>)}
        </details>
      )}
      <div className="toolbar" id="rumors">
        <FilterLinks params={params} name="days" value={days === 7 ? "" : String(days)} reset={["page"]} options={[{ value: "", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
        <FilterLinks params={params} name="tickers" value={withTickers ? "1" : ""} reset={["page"]} options={[{ value: "", label: "all" }, { value: "1", label: "with tickers" }]} />
        <FilterLinks params={params} name="cat" value={cat} reset={["page"]} options={[{ value: "", label: "every kind" }, ...CATEGORIES.filter((c) => counts.get(c)).map((c) => ({ value: c, label: c, count: counts.get(c) }))]} />
      </div>
      {rows.length === 0 && <p className="small muted">No rumors in this window yet.</p>}
      {page.items.map((r) => {
        const done = checked.get(r.id);
        return (
          <section key={r.id} className="card rumor-item">
            <div>
              <span className="tag">{r.category}</span>{" "}
              {r.tickers.slice(0, 5).map((t, i) => <span key={t}>{i ? ", " : ""}<Ticker symbol={t} className={r.direction === "long" ? "pos" : r.direction === "short" ? "neg" : "accent"} /></span>)}
              {r.tickers.length > 0 && r.direction !== "none" && <span className={`small ${r.direction === "long" ? "pos" : "neg"}`}> {r.direction === "long" ? "▲ if true" : "▼ if true"}</span>}
            </div>
            <div>{r.claim}</div>
            <div className="small muted">{SPEC[r.specificity] ?? ""} · {r.timeframe ? `timing: ${r.timeframe} · ` : ""}from {r.source || r.docSource} · {etLabel(r.createdAt)}</div>
            {r.mainstream && (
              <div className="small">
                Mainstream news: {r.mainstream.headlines7d} headline{r.mainstream.headlines7d === 1 ? "" : "s"} on {r.tickers.join(", ")} this week
                {r.mainstream.matches.length ? <>; similar: {r.mainstream.matches.map((m, i) => <span key={i}>{i ? "; " : ""}<a href={m.url} target="_blank" rel="noreferrer">{m.headline}</a></span>)}</> : <span className="muted">; nothing like the rumor</span>}
              </div>
            )}
            {r.confirm && <div className="small secondary">Would be confirmed by: {r.confirm}</div>}
            {r.quote && <details className="small"><summary>Quote</summary>&ldquo;{r.quote}&rdquo;</details>}
            <div className="small rumor-actions" style={{ marginTop: 4 }}>
              {done ? (done.cardId ? <a href={`/ideas?days=90&card=${done.cardId}#card-${done.cardId}`}>checked: card #{done.cardId} ({done.outcome.replace("_", " ")})</a> : <span className="muted">checked: {done.outcome}</span>) : <RumorResearch id={r.id} />}
              <RumorInvestigate text={rumorDetails(r)} />
              <CardAsk symbol={r.tickers[0] ?? ""} tickers={r.tickers} noun="rumor" subject={`rumor #${r.id} (${r.tickers.join(", ") || r.category}): ${r.claim.slice(0, 140)}`} context={rumorDetails(r)} />
            </div>
          </section>
        );
      })}
      <Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="rumors" hash="#rumors" />
    </>
  );
}
