import Direction from "@/components/Direction";
import Feedback from "@/components/Feedback";
import Pager, { paginate } from "@/components/Pager";
import type { Feedback as FeedbackRow } from "@/lib/scout/store";
import { fmtEtAgo } from "@/lib/time";

interface StoriesDetail { headlinesRead: number; detected: Array<{ key: string; symbols: string[]; stories: number; mainstream: number; shockHits: number; stage?: number | null; escalation?: string[]; building?: boolean; coverage?: string | null; staleness?: number | null; latest?: string; sample: string[]; samples?: Array<{ at: string; headline: string }> }>; triage: Array<{ key: string; summary: string; skipped: string | null; labels?: { novelty: string; nature: string; complexity: string }; trades: Array<{ ticker: string; direction: string; role: string; play?: string; horizon_days: number }>; attention?: string[] }>; researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>; error: string | null }
interface GapRow { key: string; ticker: string; storyDate: string; ageDays: number; gap: boolean; loud: boolean; building?: boolean; quiet: boolean; why: string }
interface FollowupDetail { checked: GapRow[]; researched: Array<{ term: string; outcome: string; reason?: string; cardId?: number }>; skipped: Array<{ key: string; reason: string }>; error: string | null }
type Run = { action: string; startedAt: string; detail: unknown };

const cardLink = (id: number) => `/cards/${id}`;

/** A story scan's report (not the note a daily pass leaves when it had no time for the scan). */
export const isStoriesDetail = (x: unknown): x is StoriesDetail => !!x && typeof x === "object" && Array.isArray((x as { detected?: unknown }).detected) && Array.isArray((x as { triage?: unknown }).triage);
/** A follow-up pass's report (not a note). */
export const isFollowupDetail = (x: unknown): x is FollowupDetail => !!x && typeof x === "object" && Array.isArray((x as { checked?: unknown }).checked);

/** The story desk's reports: reaction gaps (follow-ups) and the last story scan. Both folded by default. */
export default function StoryDesk({ runs, fb, params, spage }: { runs: Run[]; fb: Map<string, FeedbackRow>; params: Record<string, string | undefined>; spage: number }) {
  // A daily pass that had no time for a step records a note ("later: no time left in this pass") in its place: only a real report counts.
  const scanOf = (r: Run): StoriesDetail | null => { const x = r.action === "stories" ? r.detail : (r.detail as { stories?: unknown } | null)?.stories; return isStoriesDetail(x) ? x : null; };
  const last = runs.find((r) => (r.action === "stories" || r.action === "daily") && scanOf(r));
  const d = last ? scanOf(last) : null;
  const followOf = (r: Run): FollowupDetail | null => { const x = (r.detail as { followups?: unknown } | null)?.followups; return isFollowupDetail(x) ? x : null; };
  const daily = runs.find((r) => r.action === "daily" && followOf(r));
  const fu = daily ? followOf(daily) : null;
  const detected = d ? d.detected.slice().sort((a, b) => (b.latest ?? "").localeCompare(a.latest ?? "")) : [];
  const scanPage = paginate(detected, spage, 15);
  return (
    <>
      {d && (
        <details className="card section" id="scan">
          <summary><h2>Story desk · last scan {last ? fmtEtAgo(last.startedAt) : ""} · {d.headlinesRead} headlines read</h2> <span className="small muted">{detected.length} stories</span></summary>
          <p className="small muted" style={{ marginTop: -4 }}>Freshest story first; headlines newest first.</p>
          {d.error && <p className="small warn">{d.error}</p>}
          {d.detected.length === 0 && !d.error && <p className="small muted">No story stood out in the last 24 hours.</p>}
          {scanPage.items.map((s) => {
            const tr = d.triage.find((x) => x.key === s.key);
            return (
              <div key={s.key} style={{ borderTop: "1px solid var(--grid)", padding: "8px 0" }}>
                <b>{s.key}</b> {s.stage ? <span className="tag late" title={`institutions acting: ${(s.escalation ?? []).join(", ")}`}>stage {s.stage}</span> : null} {s.building ? <span className="tag late">building</span> : null} {s.latest ? <span className="small">latest {fmtEtAgo(s.latest)}</span> : null} <span className="small muted">{s.stories} headlines · {s.mainstream} mainstream · {s.shockHits} event words{s.symbols.length > 1 ? ` · ${s.symbols.join(", ")}` : ""}</span>
                {s.samples ? (
                  <ul className="small secondary" style={{ margin: "4px 0", paddingLeft: 18 }}>{s.samples.map((h) => <li key={h.at + h.headline}><span className="muted">{fmtEtAgo(h.at)}</span> {h.headline}</li>)}</ul>
                ) : <div className="small secondary">{s.sample.join(" · ")}</div>}
                {s.coverage && <div className="small muted">{s.coverage}{s.staleness !== undefined && s.staleness !== null ? ` · staleness ${s.staleness.toFixed(2)}${s.staleness >= 0.45 ? " (mostly re-reported)" : ""}` : ""}</div>}
                {tr?.labels && <div className="inline" style={{ marginTop: 4 }}><span className={`tag ${tr.labels.novelty === "stale" ? "late" : "ok"}`}>{tr.labels.novelty}</span><span className="tag">{tr.labels.nature}</span><span className="tag">{tr.labels.complexity}</span></div>}
                {(tr?.attention ?? []).map((line) => <div key={line} className="small muted">👁 {line}</div>)}
                {tr && <div className="small" style={{ marginTop: 4 }}>{tr.summary} {tr.skipped ? <span className="muted">— skipped: {tr.skipped}</span> : tr.trades.map((x) => <span key={x.ticker} style={{ display: "inline-block", margin: "4px 6px 0 0" }}><Direction direction={x.direction as "long" | "short"} ticker={x.ticker} size="small" /> <span className="tag">{x.role.replace("_", "-")}{x.play ? ` · ${x.play}` : ""} · {x.horizon_days}d</span></span>)}</div>}
                <Feedback target={`story:${s.key}`} initial={fb.get(`story:${s.key}`) ? { vote: fb.get(`story:${s.key}`)!.vote, note: fb.get(`story:${s.key}`)!.note } : null} />
              </div>
            );
          })}
          <Pager params={params} name="spage" page={scanPage.page} pages={scanPage.pages} total={scanPage.total} label="stories in the last scan" hash="#scan" />
        </details>
      )}
      {fu && (
        <details className="card section">
          <summary><h2>Story desk · reaction gaps, checked {daily ? fmtEtAgo(daily.startedAt) : ""}</h2> <span className="small muted">{fu.checked.length} checked · {fu.checked.filter((g) => g.gap).length} gap(s)</span></summary>
          <p className="small secondary" style={{ marginTop: -4 }}>Stories seen 1–10 days ago, looked at again once a day: still loud in the news (recent stories a day at least twice the pre-story pace) or still growing day after day, while the stock has moved less than 5% against SPY. A gap goes back to the desk as a follow-up, once per story.</p>
          {fu.error && <p className="small warn">{fu.error}</p>}
          {fu.checked.length === 0 && !fu.error && <p className="small muted">No recent stories to check yet.</p>}
          {fu.checked.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Story</th><th>Ticker</th><th>Seen</th><th>Now</th><th>Outcome</th></tr></thead>
              <tbody>{fu.checked.slice().sort((a, b) => Number(b.gap) - Number(a.gap) || a.ageDays - b.ageDays).map((g) => {
                const fk = `${g.key} (follow-up)`;
                const res = fu.researched.filter((r) => r.term.startsWith(`story: ${fk} → `));
                const sk = fu.skipped.find((x) => x.key === fk);
                return (
                  <tr key={g.key + g.ticker}>
                    <td>{g.key}</td><td><b>{g.ticker}</b></td><td className="small">{g.storyDate} · {g.ageDays}d ago</td>
                    <td className="small">{g.gap ? <span className="tag ok">gap</span> : <span className="tag">{!g.loud && !g.building ? "faded" : "already moved"}</span>}{g.building ? <span className="tag late">building</span> : null} <span className="secondary">{g.why}</span></td>
                    <td className="small">{res.length ? res.map((r) => <div key={r.term}>{r.term.split(" → ")[1]}: {r.cardId ? <a href={cardLink(r.cardId)}>{r.outcome}</a> : `${r.outcome}${r.reason ? ` (${r.reason})` : ""}`}</div>) : sk ? <span className="muted">skipped: {sk.reason}</span> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </details>
      )}
    </>
  );
}
