import { KIND_LABEL, type Kind } from "@/config/scout";
import Direction from "@/components/Direction";
import Feedback from "@/components/Feedback";
import { after } from "next/server";
import { marketDataFromEnv } from "@/lib/alpaca";
import { quote, sessionLabel } from "@/lib/market/quotes";
import { hasDatabase } from "@/lib/db";
import { namesMatch, notCommon } from "@/lib/scout/identity";
import * as store from "@/lib/scout/store";
import type { Feedback as FeedbackRow, StoredCard, StoredReview, Track } from "@/lib/scout/store";
import { daysBetween, fmtEt, toEt } from "@/lib/time";

const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`);

/** One thesis card, fully laid out. Server component; actions are passed in. */
const VERDICT: Record<string, [string, string]> = { played_out: ["✓ played out", "pos"], did_not: ["✗ did not play out", "neg"], mixed: ["~ mixed", "warn"], too_early: ["… too early to tell", "muted"] };

export default async function CardView({ c, track, actions, feedback, opposing, review }: { c: StoredCard; track?: Track | null; actions?: React.ReactNode; feedback?: FeedbackRow | null; opposing?: number[]; review?: StoredReview | null }) {
  const k = c.card;
  let info = hasDatabase() ? (await store.symbolInfo([c.primaryTicker]).catch(() => new Map())).get(c.primaryTicker) ?? null : null;
  // Not looked up yet (an older card): look it up now, for at most a few seconds; anything slower finishes after the response.
  if (hasDatabase() && !info) {
    const lookup = import("@/lib/scout/symbols").then(({ refreshSymbolInfo }) => refreshSymbolInfo(marketDataFromEnv(), process.env, [c.primaryTicker], new Date())).catch((err) => console.warn(`card #${c.id} symbol lookup: ${err}`));
    const done = await Promise.race([lookup.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
    if (done) info = (await store.symbolInfo([c.primaryTicker]).catch(() => new Map())).get(c.primaryTicker) ?? null;
    else after(() => lookup);
  }
  const q = await quote(c.primaryTicker);
  const company = k.tickers.find((t) => t.symbol === c.primaryTicker)?.company ?? null;
  // Warn when the symbol trades as something other than the company's stock (a reused ticker).
  const wrong = !!info?.name && (info.tradable === false || !!notCommon(info.name) || (!!company && !namesMatch(company, info.name)));
  const today = toEt(new Date()).date;
  const nextE = info?.nextEarnings && daysBetween(today, info.nextEarnings) >= -3 ? info.nextEarnings : null;
  const beforeExit = nextE && track && !track.exitDate && nextE <= track.deadlineDate;
  return (
    <section className="card thesis" id={`card-${c.id}`}>
      <div>
        <div className="inline">
          <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>
          <span className="tag">{KIND_LABEL[c.kind as Kind] ?? c.kind}</span>
          <span className="tag">{c.origin === "human" ? "human-originated" : "scout"}</span>
          <span className="small muted" title={`card #${c.id} · ${c.model} · version ${c.versionId}`}>{fmtEt(c.createdAt)}</span>
        </div>
        {track?.excluded && <div className="small neg" style={{ marginTop: 6 }}><b>Excluded from scoring: wrong security.</b> {track.excluded}</div>}
        <div style={{ margin: "8px 0 4px" }}><Direction direction={c.direction} ticker={c.primaryTicker} name={info?.name ?? company ?? (info ? "company name unavailable" : "company name loading — reload in a moment")} warn={wrong} />
          {q ? (
            <span className="quote" title={`Last trade ${q.at ? fmtEt(q.at) : ""} (IEX feed; may differ slightly from the consolidated price). Change vs the previous session's close.`}>
              <b>${q.price.toFixed(q.price < 1 ? 4 : 2)}</b>
              {q.changePct !== null && <span className={q.changePct >= 0 ? "pos" : "neg"}> {pct(q.changePct, 2)} {sessionLabel(q)}</span>}
            </span>
          ) : null}
          {opposing?.length ? <span className="tag warn" style={{ marginLeft: 8 }}>⚠ opposite call on {c.primaryTicker}: {opposing.map((id) => <a key={id} href={`/candidates?days=90#card-${id}`}>#{id} </a>)}</span> : null}</div>
        <div className="small secondary">
          {nextE ? <>Next earnings <b>~{fmtDay(nextE)}</b> <span className="muted">({info!.nextBasis})</span></>
            : info?.lastEarnings ? <>Next earnings: not enough history to estimate <span className="muted">(last release {fmtDay(info.lastEarnings)})</span></>
            : info ? <>Next earnings: unknown <span className="muted">(no earnings releases on file at the SEC — a fund, an ADR or a new listing)</span></>
            : <>Next earnings: loading — reload in a moment</>}
          {beforeExit ? <span className="tag warn" style={{ marginLeft: 6 }}>before this card&apos;s exit ({fmtDay(track!.deadlineDate)})</span> : null}
        </div>
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
        {k.expression && <><dt>How to trade it</dt><dd>{k.expression} <span className="small muted">(timing note, not a recommendation; tracked in shares)</span></dd></>}
        {k.unknowns.length > 0 && <><dt>Unknowns</dt><dd>{k.unknowns.join("; ")}</dd></>}
        {c.gateNotes.length > 0 && <><dt>Gate notes</dt><dd className="small secondary">{c.gateNotes.join(" · ")}</dd></>}
        {track && <><dt>Paper track</dt><dd className="small">{trackLine(track)}</dd></>}
        {review && <><dt>After the catalyst</dt><dd className="small"><b className={VERDICT[review.verdict]?.[1] ?? ""}>{VERDICT[review.verdict]?.[0] ?? review.verdict}</b> <span className="muted">({fmtEt(review.createdAt)}{review.moveSinceEntryPct !== null ? `; trade ${review.moveSinceEntryPct >= 0 ? "+" : ""}${review.moveSinceEntryPct}% since entry` : ""})</span> — {review.summary}{review.evidence.length ? <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{review.evidence.map((e, i) => <li key={i} className="muted">{e.date} [{e.source}] {e.headline}</li>)}</ul> : null}</dd></>}
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
