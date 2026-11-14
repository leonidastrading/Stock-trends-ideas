import { KIND_LABEL, type Kind } from "@/config/scout";
import Direction from "@/components/Direction";
import Feedback from "@/components/Feedback";
import type { Feedback as FeedbackRow, StoredCard, Track } from "@/lib/scout/store";
import { fmtEt } from "@/lib/time";

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`);

/** One thesis card, fully laid out. Server component; actions are passed in. */
export default function CardView({ c, track, actions, feedback, opposing }: { c: StoredCard; track?: Track | null; actions?: React.ReactNode; feedback?: FeedbackRow | null; opposing?: number[] }) {
  const k = c.card;
  return (
    <section className="card thesis" id={`card-${c.id}`}>
      <div>
        <div className="inline">
          <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>
          <span className="tag">{KIND_LABEL[c.kind as Kind] ?? c.kind}</span>
          <span className="tag">{c.origin === "human" ? "human-originated" : "scout"}</span>
          <span className="small muted">#{c.id} · {fmtEt(c.createdAt)} · {c.model} · v{c.versionId}</span>
        </div>
        <div style={{ margin: "8px 0 4px" }}><Direction direction={c.direction} ticker={c.primaryTicker} />
          {opposing?.length ? <span className="tag warn" style={{ marginLeft: 8 }}>⚠ opposite call on {c.primaryTicker}: {opposing.map((id) => <a key={id} href={`/candidates?days=90#card-${id}`}>#{id} </a>)}</span> : null}</div>
        <h2 style={{ margin: "6px 0 2px" }}>{k.title}</h2>
        <div className="scores">
          <span>novelty <b>{k.scores.novelty}</b></span><span>materiality <b>{k.scores.materiality}</b></span><span>breadth <b>{k.scores.breadth_of_evidence}</b></span>
          <span>lateness <b>{k.scores.lateness}</b></span><span>confidence <b>{k.confidence}</b></span><span>rank <b>{c.rankScore}</b></span>
        </div>
      </div>
      <dl>
        <dt>Observation</dt><dd>{k.observation}</dd>
        <dt>Why not priced</dt><dd>{k.why_not_priced}</dd>
        <dt>Tickers</dt>
        <dd>{k.tickers.map((t, i) => <div key={t.symbol}><b className={c.direction === "long" ? "pos" : "neg"}>{c.direction === "long" ? "▲" : "▼"} {t.symbol}</b> {i === 0 ? <span className="tag">tracked on paper</span> : null} <span className="small muted">({t.sector.replace("_", " ")}{t.revenue_share_pct === null ? ", share unknown" : `, ${t.revenue_share_pct}% of revenue${t.share_is_estimate ? " (estimate)" : ""}`})</span> — {t.why}</div>)}</dd>
        <dt>Lateness</dt>
        <dd className={k.lateness.already_obvious ? "warn" : ""}>{pct(k.lateness.stock_move_30d_pct)} over 30 days, {pct(k.lateness.stock_move_90d_pct)} over 90 days, {k.lateness.news_stories_30d} mainstream stories in 30 days{k.lateness.already_obvious ? " — already obvious" : ""}</dd>
        <dt>Catalyst</dt><dd>{k.catalyst.what} <span className="muted">({k.catalyst.date})</span></dd>
        <dt>Invalidation</dt><dd>{k.invalidation}</dd>
        <dt>Time limit</dt><dd>{k.time_limit_days} days</dd>
        {k.unknowns.length > 0 && <><dt>Unknowns</dt><dd>{k.unknowns.join("; ")}</dd></>}
        {c.gateNotes.length > 0 && <><dt>Gate notes</dt><dd className="small secondary">{c.gateNotes.join(" · ")}</dd></>}
        {track && <><dt>Paper track</dt><dd className="small">{trackLine(track)}</dd></>}
      </dl>
      <div>
        <h3>Evidence</h3>
        <ul className="evidence">{k.evidence.map((e, i) => <li key={i}><span className="src">{e.source}</span>{e.metric}: {e.value} <span className="muted">({e.change_vs_12m} vs 12m, as of {e.as_of})</span></li>)}</ul>
      </div>
      {actions && <div className="actions">{actions}</div>}
      <Feedback target={`card:${c.id}`} initial={feedback ? { vote: feedback.vote, note: feedback.note } : null} />
    </section>
  );
}

function trackLine(t: Track): string {
  if (!t.entryDate) return `entry pending: next open after ${t.cardDate}; exit by ${t.deadlineDate}`;
  const entry = `entered ${t.entryDate} at ${t.entryPrice?.toFixed(2)}`;
  if (t.exitDate) return `${entry}; exited ${t.exitDate} at ${t.exitPrice?.toFixed(2)} (${t.exitReason}); worst drawdown ${pct(t.maxDrawdownPct)}`;
  return `${entry}; open, exit by ${t.deadlineDate}; worst drawdown so far ${pct(t.maxDrawdownPct)}${t.tappedAt ? "; sent to the Swing ideas log" : ""}`;
}
