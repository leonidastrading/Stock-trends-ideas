import SetupNotice from "@/components/SetupNotice";
import Ticker from "@/components/Ticker";
import CardAsk from "@/components/CardAsk";
import { marketDataFromEnv } from "@/lib/alpaca";
import { hasDatabase } from "@/lib/db";
import { themeRuns, themeSends, type Theme, type ThemeRun } from "@/lib/scout/themes";
import { swingConfigured } from "@/lib/scout/swing";
import { fmtEt } from "@/lib/time";
import { ThemeResearch, ThemeSend, ThemesRefresh } from "./ThemeButtons";
import StockChart from "@/components/StockChart";
import CardCollapse, { CollapseAll } from "@/components/CardCollapse";
import { tvSymbol } from "@/config/links";
import * as store from "@/lib/scout/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`);

/** Pure: the idea's move since it was published, direction-adjusted, averaged over its tickers. */
function since(t: Theme, now: Record<string, number>): { each: Array<{ s: string; move: number | null }>; avg: number | null } {
  const sign = t.direction === "short" ? -1 : 1;
  const each = t.tickers.map((s) => ({ s, move: t.prices?.[s] && now[s] ? sign * (now[s] / t.prices[s] - 1) * 100 : null }));
  const known = each.filter((e) => e.move !== null).map((e) => e.move!);
  return { each, avg: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null };
}

function details(t: Theme, run: ThemeRun): string {
  return [
    `Consensus theme from ${run.etDate}: ${t.title} (${t.direction} ${t.tickers.join(", ")}), confidence ${t.confidence}.`,
    `Thesis: ${t.thesis}`, `Catalyst: ${t.catalyst}`,
    `Agreement: ${t.agreement.documents} documents, ${t.agreement.websites} website articles, ${t.agreement.stocktwits} Stocktwits posts. ${t.quotes.map((q) => `"${q.text}" (${q.source})`).join("; ")}`,
    `Disagreement: ${t.disagreement}`, `Crowding: ${t.crowding}`, `What would break it: ${t.breaks_it}`,
    t.prices ? `Prices when published: ${Object.entries(t.prices).map(([s, p]) => `${s} $${p.toFixed(2)}`).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Themes: the top 3 trade ideas the trader's sources talk about and agree on, for the next 1-2 weeks. */
export default async function ThemesPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [runs, sends] = await Promise.all([themeRuns(30).catch(() => []), themeSends().catch(() => new Map<string, string>())]);
  const sw = swingConfigured();
  const syms = [...new Set(runs.flatMap((r) => r.themes.flatMap((t) => t.tickers)))];
  const snaps = syms.length ? await (marketDataFromEnv()?.getSnapshots?.(syms) ?? Promise.resolve({})).catch(() => ({})) : {};
  const now = Object.fromEntries(Object.entries(snaps as Record<string, { price: number }>).map(([s, v]) => [s, v.price]));
  const [latest, ...older] = runs;
  // The exchange of each idea's main ticker, so the chart opens the right listing.
  const info = latest ? await store.symbolInfo(latest.themes.map((t) => t.tickers[0]).filter(Boolean)).catch(() => new Map<string, store.SymbolInfo>()) : new Map<string, store.SymbolInfo>();
  return (
    <>
      <h1>Themes</h1>
      <p className="small secondary">The 3 trade ideas most of your sources are talking about and agree on, for the next 1–2 weeks. Read once each weekday morning from the last 14 days of your inbox files, your websites&apos; articles and Stocktwits chatter. Consensus is not an edge: each idea says how crowded it looks and what would break it, and &quot;Research it&quot; checks what is already priced before anything is tracked.</p>
      <div className="toolbar">
        <ThemesRefresh />
        {latest && <span className="small muted">Last read {fmtEt(latest.createdAt)} from {latest.sources.documents} documents, {latest.sources.websites} website articles and {latest.sources.stocktwits} Stocktwits posts{latest.costUsd !== null ? ` · $${latest.costUsd.toFixed(2)}` : ""}</span>}
      </div>
      {!latest && <p className="small muted">No themes yet. The first reading runs on the next weekday morning (from 7 AM ET), or press Refresh now.</p>}
      {latest && latest.themes.length === 0 && <p className="small muted">The last reading found no idea that several sources agree on.</p>}
      {latest && latest.themes.length > 0 && <div className="toolbar"><CollapseAll /></div>}
      {latest?.themes.map((t, i) => {
        const s = since(t, now);
        return (
          <CardCollapse key={i} id={latest.id * 10 + i} prefix="theme" className="theme">
            <div>
            <div className="theme-head">
              <span className="theme-rank">#{i + 1}</span>
              <span className={`theme-dir ${t.direction === "long" ? "pos" : "neg"}`}>{t.direction === "long" ? "▲ LONG" : "▼ SHORT"}</span>
              {t.tickers.map((x) => <Ticker key={x} symbol={x} className="theme-ticker" />)}
              <span className="tag">confidence {t.confidence}</span>
              {s.avg !== null && <span className={`tag ${s.avg >= 0 ? "ok" : "neg"}`} title="Direction-adjusted move since it was published, averaged over its tickers">{pct(s.avg)} since {latest.etDate.slice(5)}</span>}
            </div>
            <h3 className="theme-title">{t.title}</h3>
            {/* Written with the theme and never changed; older themes get a fixed one from their own title. */}
            <div className={`card-thesis card-thesis-${t.direction}`}><span className="card-thesis-label">{t.direction === "long" ? "▲" : "▼"} Thesis</span> {t.one_line?.trim() || `${t.direction === "long" ? "Long" : "Short"} ${t.tickers.join(", ")}: ${t.title.replace(/\.$/, "")}.`}</div>
            </div>
            <div>{t.thesis}</div>
            <div className="small" style={{ marginTop: 6 }}><b>Catalyst:</b> {t.catalyst || "none dated"}</div>
            <div className="small theme-agree">
              <b>Who agrees:</b> <span className="tag">{t.agreement.documents} documents</span><span className="tag">{t.agreement.websites} website articles</span><span className="tag">{t.agreement.stocktwits} Stocktwits posts</span>
            </div>
            {t.quotes.length > 0 && <ul className="small theme-quotes">{t.quotes.map((q, k) => <li key={k}>&ldquo;{q.text}&rdquo; <span className="muted">— {q.source}</span></li>)}</ul>}
            {t.disagreement && <div className="small"><b>Who disagrees:</b> {t.disagreement}</div>}
            <div className="small warn" style={{ marginTop: 4 }}><b>Crowding:</b> {t.crowding}</div>
            <div className="small" style={{ marginTop: 4 }}><b>What would break it:</b> {t.breaks_it}</div>
            {s.each.some((e) => e.move !== null) && <div className="small muted" style={{ marginTop: 4 }}>Since published: {s.each.map((e) => `${e.s} ${pct(e.move)}${t.prices?.[e.s] ? ` (from $${t.prices[e.s].toFixed(2)})` : ""}`).join(" · ")}</div>}
            {t.tickers[0] && <div style={{ marginTop: 10 }}><StockChart symbol={t.tickers[0]} tvSymbol={tvSymbol(t.tickers[0], info.get(t.tickers[0])?.exchange)} height={520} entry={{ date: latest.etDate, price: t.prices?.[t.tickers[0]] ?? null, direction: t.direction, label: "theme published" }} /></div>}
            <div className="small rumor-actions" style={{ marginTop: 8 }}>
              <ThemeSend run={latest.id} index={i} ticker={t.tickers[0]} side={t.direction} sent={sends.has(`${latest.id}:${i}`)} configured={sw} />
              <ThemeResearch run={latest.id} index={i} />
              <CardAsk symbol={t.tickers[0]} tickers={t.tickers} noun="theme" subject={`theme "${t.title}" (${t.direction} ${t.tickers.join(", ")})`} context={details(t, latest)} />
            </div>
          </CardCollapse>
        );
      })}
      {older.length > 0 && (
        <section className="card section">
          <h2>Earlier readings</h2>
          <p className="small muted">How each day&apos;s ideas have done since (direction-adjusted, at today&apos;s prices).</p>
          <div className="table-wrap"><table><thead><tr><th>Day</th><th>#</th><th>Idea</th><th>Call</th><th className="num">Since</th></tr></thead>
            <tbody>{older.flatMap((r) => r.themes.map((t, i) => {
              const s = since(t, now);
              return <tr key={`${r.id}-${i}`}><td className="small">{r.etDate}</td><td>{i + 1}</td><td className="small">{t.title}</td><td className="small"><span className={t.direction === "long" ? "pos" : "neg"}>{t.direction === "long" ? "▲" : "▼"}</span> {t.tickers.map((x, k) => <span key={x}>{k ? ", " : ""}<Ticker symbol={x} /></span>)}</td><td className={`num ${s.avg === null ? "" : s.avg >= 0 ? "pos" : "neg"}`}>{pct(s.avg)}</td></tr>;
            }))}</tbody></table></div>
        </section>
      )}
    </>
  );
}
