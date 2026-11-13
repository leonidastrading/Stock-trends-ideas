import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import SetupNotice from "@/components/SetupNotice";
import { SCOUT } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { digestCards } from "@/lib/scout/digest";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DigestPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [week, tracks, health, fb] = await Promise.all([store.cardsSince(7), store.allTracks(), store.allHealth(), store.latestFeedback()]);
  const top = digestCards(week);
  const late = week.filter((c) => c.status === "late").sort((a, b) => b.rankScore - a.rankScore);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const down = health.filter((h) => h.status === "down" || h.status === "missing");
  const sw = swingConfigured();
  return (
    <>
      <h1>Weekly digest</h1>
      <section className="card notice small">
        The top {SCOUT.digestCards} promoted cards of the last 7 days, ranked by novelty × materiality, with lateness shown. One tap sends a card to the Swing ideas log as a paper idea.
        Every promoted and late card is tracked on paper here whether or not you tap it, from the next open after the card to the earlier of the day after its catalyst, its time limit, or the invalidation being met.
        {down.length > 0 && <div className="warn" style={{ marginTop: 6 }}>Sources not reporting: {down.map((h) => `${h.source} (${h.status})`).join(", ")}. See Settings.</div>}
        {!sw && <div className="muted" style={{ marginTop: 6 }}>Sending to the Swing ideas log is not configured yet (SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD).</div>}
      </section>
      {top.length === 0 && <section className="card"><p className="muted">No promoted cards this week. The daily scan runs on weekday mornings; see <a href="/candidates">Candidates</a> for what it considered.</p></section>}
      {top.map((c) => {
        const tr = t.get(c.id) ?? null;
        return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} actions={<CardActions cardId={c.id} canSend sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} />} />;
      })}
      {late.length > 0 && (
        <>
          <h2>Late this week (logged and scored, never promoted)</h2>
          <p className="small secondary">Already up more than {SCOUT.lateStockMove30dPct}% in 30 days or past {SCOUT.lateNewsStories30d} mainstream stories. Tracked on paper so the lateness gate can be checked: if these do as well as the promoted cards, the gate is not helping.</p>
          {late.map((c) => {
            const tr = t.get(c.id) ?? null;
            return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} actions={<CardActions cardId={c.id} canSend sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} />} />;
          })}
        </>
      )}
    </>
  );
}
