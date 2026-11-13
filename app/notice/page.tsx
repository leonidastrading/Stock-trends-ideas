import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import NoticeForm from "./NoticeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NoticePage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [cards, tracks, spend, fb] = await Promise.all([store.cardsSince(90), store.allTracks(), store.spendByDay(1), store.latestFeedback()]);
  const human = cards.filter((c) => c.origin === "human").slice(0, 10);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  return (
    <>
      <h1>I noticed something</h1>
      <section className="card notice small">
        The method starts with a person noticing something. Type it here; the scout measures it on every source, writes a thesis card and runs the gates, usually within a few minutes.
        These cards are tagged human-originated and scored on their own, so after six months you can see whether the research adds anything to what you noticed yourself.
        {spend[0] ? <div className="muted" style={{ marginTop: 6 }}>LLM spend today: ${spend[0].cost.toFixed(2)} over {spend[0].calls} calls.</div> : null}
      </section>
      <section className="card"><NoticeForm /></section>
      {human.length > 0 && <h2>Your recent cards</h2>}
      {human.map((c) => <CardView key={c.id} c={c} track={t.get(c.id) ?? null} feedback={fb.get(`card:${c.id}`) ?? null} />)}
    </>
  );
}
