import LinkedText from "@/components/LinkedText";
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
import { latestChecks, type RumorCheck } from "@/lib/scout/rumor-check";

const TRUTH: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "✅ CAME TRUE", cls: "truth-confirmed" },
  partly: { label: "◐ PARTLY TRUE", cls: "truth-partly" },
  denied: { label: "✗ DENIED", cls: "truth-denied" },
  already_news: { label: "📰 ALREADY NEWS", cls: "truth-denied" },
};

/** The verdict banner: big and green when the rumor came true. */
function Verdict({ c }: { c: RumorCheck }) {
  const t = TRUTH[c.status];
  if (!t) return <div className="small muted">Checked {etLabel(c.checkedAt)}: not confirmed yet{c.evidence.length ? ` (${c.evidence.length} related headline${c.evidence.length === 1 ? "" : "s"})` : ""}.</div>;
  return (
    <div className={`truth ${t.cls}`}>
      <div className="truth-label">{t.label}</div>
      {c.note && <div className="truth-note">{c.note}</div>}
      {c.evidence.slice(0, 3).map((e, i) => <div key={i} className="truth-ev"><a href={e.url} target="_blank" rel="noreferrer">{e.headline}</a> <span className="small">· {e.source} · {etLabel(e.at)}</span></div>)}
      <div className="small truth-when">checked {etLabel(c.checkedAt)}</div>
    </div>
  );
}

/** Pure: a rumor written out in full, for the investigation and the scout's answer. */
function rumorDetails(r: Rumor, c?: RumorCheck): string {
  return [
    `UNVERIFIED rumor from ${r.docSource}${r.source ? ` (${r.source})` : ""}, logged ${r.createdAt.slice(0, 10)}: ${r.claim}`,
    r.tickers.length ? `Tickers: ${r.tickers.join(", ")}${r.direction !== "none" ? `; if true: ${r.direction} ${r.tickers[0]}` : ""}.` : "",
    r.timeframe ? `Supposed timing: ${r.timeframe}.` : "",
    r.confirm ? `Would be confirmed by: ${r.confirm}` : "",
    r.quote ? `Quote: "${r.quote}"` : "",
    c && c.status !== "open" ? `Daily check (${c.checkedAt.slice(0, 10)}): ${c.status === "confirmed" ? "CAME TRUE" : c.status === "partly" ? "partly true" : "denied"}. ${c.note} ${c.evidence.map((e) => `${e.source}, ${e.at.slice(0, 10)}: ${e.headline}`).join("; ")}` : "",
    r.mainstream ? `Mainstream news this week: ${r.mainstream.headlines7d} headline(s) on ${r.tickers.join(", ")}${r.mainstream.matches.length ? `; similar: ${r.mainstream.matches.map((m) => m.headline).join("; ")}` : "; nothing similar"}.` : "",
  ].filter(Boolean).join("\n");
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = 25;
const SPEC = ["", "vague", "loose", "some detail", "specific", "very specific"];

/** Rumors: market-relevant claims from fringe and conspiracy sources, catalogued (never asserted) and checked against the news. */
export default async function RumorsPage({ searchParams }: { searchParams: Promise<{ days?: string; cat?: string; tickers?: string; truth?: string; page?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 7;
  const cat = (CATEGORIES as readonly string[]).includes(sp.cat ?? "") ? sp.cat! : "";
  const withTickers = sp.tickers === "1";
  const truth = ["confirmed", "partly", "denied", "already_news"].includes(sp.truth ?? "") ? sp.truth! : "";
  const [all, docs, cands, cards, verdicts] = await Promise.all([rumorsSince(days), recentRumorDocs(15), store.candidatesSince(days + 1), store.cardsSince(days + 1), latestChecks().catch(() => new Map<number, RumorCheck>())]);
  const status = new Map(cards.map((c) => [c.id, c.status]));
  // Rumors already checked: their card, from the "rumor: … #id" research term.
  const checked = new Map<number, { cardId: number | null; outcome: string }>();
  for (const c of cands) {
    const id = Number(/^rumor: .*?#(\d+)/.exec(c.term)?.[1]);
    if (id) checked.set(id, { cardId: c.cardId, outcome: c.cardId ? (status.get(c.cardId) ?? "card") : c.outcome });
  }
  // Newest first (the came-true ones are one tap away under their filter).
  // A claim already reported by a credible outlet when the scout read it is news, not a rumor: only under its own filter.
  const isNews = (r: Rumor) => verdicts.get(r.id)?.status === "already_news";
  const rows = all.filter((r) => (!cat || r.category === cat) && (!withTickers || r.tickers.length > 0) && (truth ? verdicts.get(r.id)?.status === truth : !isNews(r)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const tally = (s: string) => all.filter((r) => verdicts.get(r.id)?.status === s).length;
  const rumorsOnly = all.filter((r) => !isNews(r));
  const checkedCount = rumorsOnly.filter((r) => verdicts.has(r.id)).length;
  const page = paginate(rows, Number(sp.page ?? 1), PAGE);
  const params: Record<string, string | undefined> = { days: days === 7 ? undefined : String(days), cat: cat || undefined, tickers: withTickers ? "1" : undefined, truth: truth || undefined };
  const counts = new Map<string, number>();
  for (const r of rumorsOnly) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return (
    <>
      <h1>Rumors</h1>
      <RememberFilters keys={["days", "cat", "tickers", "truth"]} />
      {tally("confirmed") > 0 && <div className="truth truth-confirmed truth-summary"><div className="truth-label">✅ {tally("confirmed")} rumor{tally("confirmed") === 1 ? "" : "s"} came true</div><div className="truth-note">{tally("partly") ? `${tally("partly")} partly true · ` : ""}{checkedCount} of {rumorsOnly.length} checked in this window. <a href="?truth=confirmed#rumors">Show them</a>.</div></div>}
      {tally("already_news") > 0 && truth !== "already_news" && <p className="small muted">{tally("already_news")} claim{tally("already_news") === 1 ? " was" : "s were"} already mainstream news when the scout read {tally("already_news") === 1 ? "it" : "them"}, so {tally("already_news") === 1 ? "it is" : "they are"} on the News tab, not listed here (<a href="?truth=already_news">show</a>).</p>}
      <p className="small warn">Unverified claims from conspiracy forums and fringe sites. Listed as claims, not facts; nothing here is researched or traded unless you press Check it.</p>
      <details className="card section">
        <summary><b>How this page works</b> <span className="small muted">where rumors come from and what the scout does with them</span></summary>
        <div className="small secondary">
          <p><b>Already news?</b> Each claim is checked against the news the moment it is read. If a credible outlet had already reported it, it is news, not a rumor: it goes to the News tab and is hidden here (filter &quot;already news&quot; shows it).</p>
          <p><b>Did it come true?</b> Every day the scout checks each rumor from the last 30 days again: mainstream headlines on its tickers since it was logged, plus a Google News search on its key words. Rumors with matching headlines go to the AI in batches (its own budget in Settings), which marks them <b>came true</b> (a credible outlet or official source now reports it as fact), <b>partly true</b>, <b>denied</b>, or not yet. Came-true rumors get a big green banner with the article, are listed first, and send a phone alert. Came true and denied are final; the rest are checked again the next day.</p>
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
        <FilterLinks params={params} name="tickers" value={withTickers ? "1" : ""} reset={["page"]} options={[{ value: "", label: "all", count: rumorsOnly.length }, { value: "1", label: "with tickers", count: rumorsOnly.filter((r) => r.tickers.length > 0).length }]} />
        <FilterLinks params={params} name="truth" value={truth} reset={["page"]} options={[{ value: "", label: "any status", count: rumorsOnly.length }, { value: "confirmed", label: "✅ came true", count: tally("confirmed") }, { value: "partly", label: "partly true", count: tally("partly") }, { value: "denied", label: "denied", count: tally("denied") }, { value: "already_news", label: "already news", count: tally("already_news") }]} />
        <FilterLinks params={params} name="cat" value={cat} reset={["page"]} options={[{ value: "", label: "every kind", count: rumorsOnly.length }, ...CATEGORIES.filter((c) => counts.get(c)).map((c) => ({ value: c, label: c, count: counts.get(c) }))]} />
      </div>
      {rows.length === 0 && <p className="small muted">No rumors in this window yet.</p>}
      {page.items.map((r) => {
        const done = checked.get(r.id);
        const v = verdicts.get(r.id);
        return (
          <section key={r.id} className={`card rumor-item${v?.status === "confirmed" ? " rumor-true" : ""}`}>
            <div className="rumor-when"><b>{etLabel(r.createdAt)}</b> <span className="muted">· rumor #{r.id} · from {r.source || r.docSource}</span></div>
            {v && v.status !== "open" && <Verdict c={v} />}
            <div>
              <span className="tag">{r.category}</span>{" "}
              {r.tickers.slice(0, 5).map((t, i) => <span key={t}>{i ? ", " : ""}<Ticker symbol={t} className={r.direction === "long" ? "pos" : r.direction === "short" ? "neg" : "accent"} /></span>)}
              {r.tickers.length > 0 && r.direction !== "none" && <span className={`small ${r.direction === "long" ? "pos" : "neg"}`}> {r.direction === "long" ? "▲ if true" : "▼ if true"}</span>}
            </div>
            <div>{r.claim}</div>
            <div className="small muted">{[SPEC[r.specificity], r.timeframe ? `timing: ${r.timeframe}` : ""].filter(Boolean).join(" · ")}</div>
            {r.mainstream && (
              <div className="small">
                Mainstream news: {r.mainstream.headlines7d} headline{r.mainstream.headlines7d === 1 ? "" : "s"} on {r.tickers.join(", ")} this week
                {r.mainstream.matches.length ? <>; similar: {r.mainstream.matches.map((m, i) => <span key={i}>{i ? "; " : ""}<a href={m.url} target="_blank" rel="noreferrer">{m.headline}</a></span>)}</> : <span className="muted">; nothing like the rumor</span>}
              </div>
            )}
            {r.confirm && <div className="small secondary">Would be confirmed by: {r.confirm}</div>}
            {v && v.status === "open" && <Verdict c={v} />}
            {r.quote && <details className="small"><summary>Quote</summary>&ldquo;{r.quote}&rdquo;</details>}
            <div className="small rumor-actions" style={{ marginTop: 4 }}>
              {done ? (done.cardId ? <a href={`/ideas?days=90&card=${done.cardId}#card-${done.cardId}`}>checked: card #{done.cardId} ({done.outcome.replace("_", " ")})</a> : <span className="muted">checked: <LinkedText text={done.outcome} /></span>) : <RumorResearch id={r.id} />}
              <RumorInvestigate text={rumorDetails(r, v)} />
              <CardAsk symbol={r.tickers[0] ?? ""} tickers={r.tickers} noun="rumor" subject={`rumor #${r.id} (${r.tickers.join(", ") || r.category}): ${r.claim.slice(0, 140)}`} context={rumorDetails(r, v)} />
            </div>
          </section>
        );
      })}
      <Pager params={params} name="page" page={page.page} pages={page.pages} total={page.total} label="rumors" hash="#rumors" />
    </>
  );
}
