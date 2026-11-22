import { notFound } from "next/navigation";
import CardActions from "@/components/CardActions";
import CardChips from "@/components/CardChips";
import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { opposingCalls } from "@/lib/scout/calendar";
import { originLink } from "@/lib/scout/origin-tag";
import { PLAYER_LABEL, playerOf } from "@/lib/scout/scoreboard";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One card on its own page: the full card (thesis, evidence, chart, paper track, review), where it came from, and the other cards on the same stock. */
export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const c = await store.getCard(id);
  if (!c) notFound();
  const [track, feedback, review, src, recent, tracks, briefs] = await Promise.all([
    store.getTrack(id), store.latestFeedback().then((m) => m.get(`card:${id}`) ?? null), store.getReview(id), store.cardSource(id),
    store.cardsSince(120), store.allTracks(), store.cardBriefsSince(365).catch(() => [] as store.CardBrief[]),
  ]);
  const opp = opposingCalls(recent.some((x) => x.id === id) ? recent : [...recent, c], tracks).get(id);
  const player = playerOf(c.origin, src?.term);
  const from = originLink(c.origin, src?.term, src?.observation, src ? { label: src.sourceLabel, url: src.sourceUrl } : null);
  const others = briefs.filter((b) => b.id !== id && (b.primaryTicker === c.primaryTicker || b.tickers.includes(c.primaryTicker)));
  return (
    <>
      <p className="small"><a href="/ideas">← All ideas</a></p>
      <div className="small muted from-line">
        From: {from.url ? <a href={from.url}>{from.tag}</a> : from.tag}{src?.term ? ` · ${src.term.replace(/^[a-z+ ]+: /i, "")}` : ""} <span className="muted">(scored as {PLAYER_LABEL[player]})</span>
      </div>
      <CardView c={c} track={track} feedback={feedback} opposing={opp} review={review} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!track?.tappedAt} open={!!track && !track.exitDate && !track.invalidatedAt} swingConfigured={swingConfigured()} excluded={!!track?.excluded} />} />
      <section className="card">
        <h2>Other cards on {c.primaryTicker}</h2>
        {others.length ? <CardChips cards={others} max={40} /> : <p className="small muted">None in the last year.</p>}
      </section>
    </>
  );
}
