import CardCollapse, { CollapseAll } from "@/components/CardCollapse";
import ResearchButton from "@/components/ResearchButton";
import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { dotsRuns, type Crowd, type DotIdea, type DotsRun } from "@/lib/scout/dots";
import * as store from "@/lib/scout/store";
import { fmtEt } from "@/lib/time";
import DotsRefresh from "./DotsRefresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`);
const CROWD: Record<Crowd["verdict"], { label: string; cls: string; tip: string }> = {
  early: { label: "early", cls: "ok", tip: "Little move and little news on the stock: the crowd has not connected this yet" },
  moving: { label: "starting to move", cls: "late", tip: "Either a big move or a lot of news on the stock already" },
  crowded: { label: "crowded", cls: "error", tip: "Big move and lots of news: the crowd is already there" },
  unknown: { label: "not measured", cls: "", tip: "No price or news data" },
};

/** Pure: the idea's move since it was published, direction-adjusted, on its main ticker. */
function since(t: DotIdea, now: Record<string, number>): number | null {
  const s = t.tickers[0];
  const from = t.prices?.[s], to = now[s];
  return from && to ? Math.round((t.direction === "long" ? 1 : -1) * (to / from - 1) * 1000) / 10 : null;
}

function details(t: DotIdea, run: DotsRun): string {
  return [
    `Second-order idea from the Dots desk (${run.etDate}): ${t.title}. ${t.one_line}`,
    `Chain: ${t.chain.join(" → ")}.`,
    `Why the market may not have it: ${t.why_not_obvious}`,
    `Headlines: ${t.evidence.map((h) => `${h.at.slice(0, 10)} [${h.source}] ${h.headline}`).join(" | ")}`,
    `Would confirm it: ${t.confirm_with}. Breaks it: ${t.breaks_it}.`,
    `Research whether the link is real: what share of the company's sales the product is, whether its own data (orders, search interest, retailer stock-outs, management comments) shows the demand, and how much the stock has already moved. Do not promote on the story alone.`,
  ].join("\n");
}

/** Dots: trade ideas from changes in what people and businesses are doing, followed to the companies nobody has connected yet. */
export default async function DotsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const runs = await dotsRuns(30).catch(() => [] as DotsRun[]);
  const [latest, ...older] = runs;
  const syms = [...new Set(runs.flatMap((r) => r.ideas.map((t) => t.tickers[0])))];
  const snaps = syms.length ? await (marketDataFromEnv()?.getSnapshots?.(syms) ?? Promise.resolve({})).catch(() => ({})) : {};
  const now = Object.fromEntries(Object.entries(snaps as Record<string, { price: number }>).map(([s, v]) => [s, v.price]));
  const briefs = await store.cardBriefsSince(120).catch(() => [] as store.CardBrief[]);
  const cardsOn = (sym: string) => briefs.filter((c) => c.primaryTicker === sym || c.tickers.includes(sym));

  return (
    <>
      <h1>Dots</h1>
      <p className="small secondary">Trade ideas nobody has connected yet. Each weekday morning the scout scans for what is changing: about 40 news searches across ten lenses (what people buy and fear, supply chains, rules and policy, weather, health, technology, security and outages, labour, geopolitics, culture), world and wire news, what Americans are searching for, what people are suddenly reading on Wikipedia, what they bet on at Polymarket, the Hacker News front page, and the scout&apos;s own rumors and stories. It picks the real changes, writes its own follow-up searches to dig into each, then follows each change to the listed companies it helps or hurts: fear of a cyber or nuclear attack → households buy backup generators → Generac. The opposite of Themes, which shows what the crowd already agrees on. Each stock is checked for how late it is: <span className="tag ok">early</span> means little move and little news so far. These are leads, not evidence: &quot;Research it&quot; checks one into a scored card.</p>
      <div className="toolbar">
        <DotsRefresh />
        {latest && <span className="small muted">Last read {fmtEt(latest.createdAt)} from {latest.headlines} lines and headlines{latest.costUsd !== null ? ` · $${latest.costUsd.toFixed(2)}` : ""}</span>}
      </div>
      {latest && latest.changes.length > 0 && (
        <details className="card section">
          <summary><b>What the scout saw changing this week</b> <span className="small muted">{latest.changes.length} changes, the searches it ran to dig in, and what it read</span></summary>
          <ol className="small">{latest.changes.map((c, i) => <li key={i}>{c.lens ? <span className="tag">{c.lens}</span> : null} {c.change} {c.searches.length ? <span className="muted">· searched: {c.searches.map((x) => `“${x}”`).join(", ")}</span> : null}</li>)}</ol>
          <div className="small muted">Read: {Object.entries(latest.sources).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ")}</div>
        </details>
      )}
      {!latest && <p className="small muted">No ideas yet. The first reading runs on the next weekday morning (from 8 AM ET), or press Refresh now.</p>}
      {latest && latest.ideas.length === 0 && <p className="small muted">The last reading found no chain worth showing.</p>}
      {latest && latest.ideas.length > 0 && <div className="toolbar"><CollapseAll /></div>}
      {latest?.ideas.map((t, i) => {
        const main = t.tickers[0];
        const s = since(t, now);
        const cards = cardsOn(main);
        return (
          <CardCollapse key={i} id={latest.id * 10 + i} prefix="dot" className="theme">
            <div>
              <div className="theme-head">
                <span className="theme-rank">#{i + 1}</span>
                <span className={`theme-dir ${t.direction === "long" ? "pos" : "neg"}`}>{t.direction === "long" ? "▲ LONG" : "▼ SHORT"}</span>
                {t.tickers.map((x) => <Ticker key={x} symbol={x} className="theme-ticker" />)}
                <span className="tag">confidence {t.confidence}</span>
                {t.crowd?.[main] && <span className={`tag ${CROWD[t.crowd[main].verdict].cls}`} title={CROWD[t.crowd[main].verdict].tip}>{CROWD[t.crowd[main].verdict].label}</span>}
                {s !== null && <span className={`tag ${s >= 0 ? "ok" : "error"}`} title="Direction-adjusted move of the main ticker since published">{pct(s)} since {latest.etDate.slice(5)}</span>}
              </div>
              <h3 className="theme-title">{t.title}</h3>
              <div className={`card-thesis card-thesis-${t.direction}`}><span className="card-thesis-label">{t.direction === "long" ? "▲" : "▼"} Thesis</span> {t.one_line || `${t.direction === "long" ? "Long" : "Short"} ${t.tickers.join(", ")}: ${t.title}.`}</div>
            </div>
            <div className="dot-chain">{t.chain.map((c, k) => <span key={k}>{k ? <span className="dot-arrow"> → </span> : null}{c}</span>)}</div>
            <div className="small"><b>Why the market may not have it:</b> {t.why_not_obvious}</div>
            {t.crowd && <div className="small muted">How late: {t.tickers.map((x) => { const c = t.crowd?.[x]; return c ? `${x} ${pct(c.move1m)} in 1 month, ${pct(c.move3m)} in 3, ${c.news30d ?? "?"} news stories in 30 days` : x; }).join(" · ")}</div>}
            {t.evidence.length > 0 && <ul className="small theme-quotes">{t.evidence.map((h, k) => <li key={k}>{h.url ? <a href={h.url} target="_blank" rel="noreferrer">{h.headline}</a> : h.headline} <span className="muted">— {h.source}, {h.at.slice(0, 10)}</span></li>)}</ul>}
            <div className="small"><b>Would confirm it:</b> {t.confirm_with}</div>
            <div className="small" style={{ marginTop: 4 }}><b>What would break it:</b> {t.breaks_it}</div>
            <div className="small muted" style={{ marginTop: 4 }}>Horizon about {t.horizon_days} days.</div>
            <div className="small rumor-actions" style={{ marginTop: 8 }}>
              {cards.length ? <span>Scout cards on {main}: {cards.slice(0, 4).map((c) => <a key={c.id} className="tag card-number" style={{ marginRight: 4 }} href={`/ideas?days=365&card=${c.id}#card-${c.id}`}><span className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"}</span> #{c.id}</a>)}</span> : null}
              <ResearchButton symbol={main} term={`dots: ${t.title}`.slice(0, 80)} observation={details(t, latest)} kind={null} />
            </div>
          </CardCollapse>
        );
      })}

      {older.length > 0 && (
        <section className="card section">
          <h2>Earlier ideas</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Idea</th><th>Main ticker</th><th>How late then</th><th className="num">Since</th></tr></thead>
            <tbody>{older.flatMap((r) => r.ideas.map((t, i) => {
              const s = since(t, now);
              const c = t.crowd?.[t.tickers[0]];
              return <tr key={`${r.id}-${i}`}><td className="small">{r.etDate}</td><td className="small">{t.title}</td><td className="small"><span className={t.direction === "long" ? "pos" : "neg"}>{t.direction === "long" ? "▲" : "▼"}</span> <Ticker symbol={t.tickers[0]} /></td><td className="small">{c ? CROWD[c.verdict].label : "—"}</td><td className={`num ${s === null ? "" : s >= 0 ? "pos" : "neg"}`}>{pct(s)}</td></tr>;
            }))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
