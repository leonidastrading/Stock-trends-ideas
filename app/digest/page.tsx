import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import Direction from "@/components/Direction";
import MarketPanels from "@/components/MarketPanels";
import Pager, { paginate } from "@/components/Pager";
import SetupNotice from "@/components/SetupNotice";
import { SCOUT } from "@/config/scout";
import { hasDatabase } from "@/lib/db";
import { digestCards } from "@/lib/scout/digest";
import { opposingCalls, upcomingCatalysts } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { toEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DigestPage({ searchParams }: { searchParams: Promise<{ late?: string }> }) {
  if (!hasDatabase()) return <SetupNotice />;
  const sp = await searchParams;
  const [week, tracks, health, fb, recent] = await Promise.all([store.cardsSince(7), store.allTracks(), store.allHealth(), store.latestFeedback(), store.cardsSince(120)]);
  const opp = opposingCalls(recent, tracks);
  const reviews = await store.allReviews();
  const coming = upcomingCatalysts(recent, tracks, toEt(new Date()).date);
  const top = digestCards(week);
  const lateAll = week.filter((c) => c.status === "late").sort((a, b) => b.rankScore - a.rankScore);
  const late = paginate(lateAll, Number(sp.late ?? 1), 10);
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const down = health.filter((h) => h.status === "down" || h.status === "missing");
  const sw = swingConfigured();
  return (
    <>
      <h1>Weekly digest</h1>
      <details className="section" open>
        <summary className="small muted">Market panels (click to collapse)</summary>
        <MarketPanels />
      </details>
      <section className="card notice small">
        The top {SCOUT.digestCards} promoted cards of the last 7 days, ranked by novelty × materiality (not by time; each card shows when it was written), with lateness shown. One tap sends a card to the Swing ideas log as a paper idea.
        Every promoted and late card is tracked on paper here whether or not you tap it, from the next open after the card to the earlier of the day after its catalyst, its time limit, or the invalidation being met.
        {down.length > 0 && <div className="warn" style={{ marginTop: 6 }}>Sources not reporting: {down.map((h) => `${h.source} (${h.status})`).join(", ")}. See Settings.</div>}
        {!sw && <div className="muted" style={{ marginTop: 6 }}>Sending to the Swing ideas log is not configured yet (SWING_API_URL / SWING_API_USER / SWING_API_PASSWORD).</div>}
      </section>
      {coming.length > 0 && (
        <details className="card section" open>
          <summary><h2>Coming up: dated catalysts on open paper tracks (next 3 weeks)</h2> <span className="small muted">{coming.length}</span></summary>
          <div className="table-wrap"><table><tbody>
            {coming.map((u) => (
              <tr key={u.cardId}>
                <td className="small" style={{ whiteSpace: "nowrap" }}>{u.date}</td>
                <td><Direction direction={u.direction} ticker={u.ticker} size="small" /></td>
                <td className="small">{u.what} <span className="muted">— <a href={`/candidates?days=90&card=${u.cardId}#card-${u.cardId}`}>#{u.cardId}</a> {u.title}</span></td>
              </tr>
            ))}
          </tbody></table></div>
        </details>
      )}
      {top.length === 0 && <section className="card"><p className="muted">No promoted cards this week. The daily scan runs at midday on weekdays; see <a href="/candidates">Candidates</a> for what it considered.</p></section>}
      {top.map((c) => {
        const tr = t.get(c.id) ?? null;
        return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} excluded={!!tr?.excluded} />} />;
      })}
      {lateAll.length > 0 && (
        <details className="section" open id="late">
          <summary><h2>Late this week (logged and scored, never promoted)</h2> <span className="small muted">{lateAll.length} · click to collapse</span></summary>
          <p className="small secondary">Already up more than {SCOUT.lateStockMove30dPct}% in 30 days or past {SCOUT.lateNewsStories30d} mainstream stories. Tracked on paper so the lateness gate can be checked: if these do as well as the promoted cards, the gate is not helping.</p>
          <Pager params={{}} name="late" page={late.page} pages={late.pages} total={late.total} label="late cards" hash="#late" />
          {late.items.map((c) => {
            const tr = t.get(c.id) ?? null;
            return <CardView key={c.id} c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate} swingConfigured={sw} excluded={!!tr?.excluded} />} />;
          })}
          <Pager params={{}} name="late" page={late.page} pages={late.pages} total={late.total} label="late cards" hash="#late" />
        </details>
      )}
    </>
  );
}
