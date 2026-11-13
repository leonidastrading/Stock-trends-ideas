import CardActions from "@/components/CardActions";
import Direction from "@/components/Direction";
import Feedback from "@/components/Feedback";
import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { fmtEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StoriesDetail { headlinesRead: number; detected: Array<{ key: string; symbols: string[]; stories: number; mainstream: number; shockHits: number; latest?: string; sample: string[]; samples?: Array<{ at: string; headline: string }> }>; triage: Array<{ key: string; summary: string; skipped: string | null; trades: Array<{ ticker: string; direction: string; role: string; horizon_days: number }> }>; researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>; error: string | null }

export default async function StoriesPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [runs, cards, tracks, candidates, fb] = await Promise.all([store.recentRuns(30), store.cardsSince(14), store.allTracks(), store.candidatesSince(14), store.latestFeedback()]);
  const last = runs.find((r) => r.action === "stories" || (r.action === "daily" && (r.detail as { stories?: unknown } | null)?.stories));
  const d = last ? ((last.action === "stories" ? last.detail : (last.detail as { stories?: StoriesDetail }).stories) as StoriesDetail | null) : null;
  const storyCards = cards.filter((c) => candidates.some((k) => k.cardId === c.id && k.term.startsWith("story: ")));
  const termOf = (id: number) => candidates.find((k) => k.cardId === id)?.term ?? "";
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const sw = swingConfigured();
  const groups = new Map<string, typeof storyCards>();
  for (const c of storyCards) {
    const key = termOf(c.id).replace(/^story: /, "").split(" → ")[0];
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <>
      <h1>Stories</h1>
      <section className="card notice small">
        Breaking stories from the news stream (a CEO scandal, a war, a ban, a pivot, a regulator's move) and the trades they imply, direct and one step away. Every trade is a card that went through the same gates:
        most are logged as <span className="tag late">late</span> because the story is already everywhere, and they are tracked on paper anyway. The Scoring page's "promoted versus late" table is where this style gets its verdict.
        Runs with the morning scan and whenever "Scan stories now" is pressed; for breaking news during the day, point an hourly cron-job.org job at <code>/api/cron/stories</code>.
      </section>
      {d && (
        <section className="card">
          <h2>Last story scan · {last ? fmtEt(last.startedAt) : ""} · {d.headlinesRead} headlines read</h2>
          <p className="small muted" style={{ marginTop: -4 }}>Freshest story first; headlines newest first.</p>
          {d.error && <p className="small warn">{d.error}</p>}
          {d.detected.length === 0 && !d.error && <p className="small muted">No story stood out in the last 24 hours.</p>}
          {d.detected.slice().sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? "")).map((s) => {
            const tr = d.triage.find((x) => x.key === s.key);
            return (
              <div key={s.key} style={{ borderTop: "1px solid var(--grid)", padding: "8px 0" }}>
                <b>{s.key}</b> {s.latest ? <span className="small">latest {fmtEt(s.latest)}</span> : null} <span className="small muted">{s.stories} headlines · {s.mainstream} mainstream · {s.shockHits} event words{s.symbols.length > 1 ? ` · ${s.symbols.join(", ")}` : ""}</span>
                {s.samples ? (
                  <ul className="small secondary" style={{ margin: "4px 0", paddingLeft: 18 }}>{s.samples.map((h) => <li key={h.at + h.headline}><span className="muted">{fmtEt(h.at)}</span> {h.headline}</li>)}</ul>
                ) : <div className="small secondary">{s.sample.join(" · ")}</div>}
                {tr && <div className="small" style={{ marginTop: 4 }}>{tr.summary} {tr.skipped ? <span className="muted">— skipped: {tr.skipped}</span> : tr.trades.map((x) => <span key={x.ticker} style={{ display: "inline-block", margin: "4px 6px 0 0" }}><Direction direction={x.direction as "long" | "short"} ticker={x.ticker} size="small" /> <span className="tag">{x.role.replace("_", "-")} · {x.horizon_days}d</span></span>)}</div>}
                <Feedback target={`story:${s.key}`} initial={fb.get(`story:${s.key}`) ? { vote: fb.get(`story:${s.key}`)!.vote, note: fb.get(`story:${s.key}`)!.note } : null} />
              </div>
            );
          })}
        </section>
      )}
      {[...groups.entries()].sort((a, b) => b[1][0].createdAt.localeCompare(a[1][0].createdAt)).map(([key, cs]) => (
        <section key={key}>
          <h2>{key} <span className="small muted">· newest card {fmtEt(cs[0].createdAt)}</span></h2>
          {cs.map((c) => {
            const tr = t.get(c.id) ?? null;
            return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} />} />;
          })}
        </section>
      ))}
      {storyCards.length === 0 && <section className="card"><p className="muted">No story cards in the last 14 days yet.</p></section>}
    </>
  );
}
