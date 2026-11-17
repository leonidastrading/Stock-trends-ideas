import Direction from "@/components/Direction";
import { paperResult } from "@/lib/scout/paper-result";
import { fmtEt } from "@/lib/time";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import ImportForm from "./ImportForm";
import NoticeForm from "./NoticeForm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NoticePage() {
  if (!hasDatabase()) return <SetupNotice />;
  const [cards, tracks, spend] = await Promise.all([store.cardsSince(90), store.allTracks(), store.spendByDay(1)]);
  const human = cards.filter((c) => c.origin === "human").slice(0, 15);
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
      <section className="card small">Documents from other bots (GitHub inbox or JSON) and their track record are on the <a href="/inbox">Inbox</a> tab.</section>
      <section className="card"><h2>Import the daily stream file</h2><ImportForm /></section>
      {human.length > 0 && (
        <section className="card">
          <h2>Your recent cards</h2>
          <p className="small muted">The full cards are on <a href="/ideas?source=you&amp;days=90&amp;sort=newest">Ideas</a> (filtered to yours).</p>
          <ul className="notice-recent">
            {human.map((c) => {
              const tr = t.get(c.id);
              const r = tr ? paperResult(tr, null, null) : null;
              return (
                <li key={c.id}>
                  <span className="small muted">{fmtEt(c.createdAt)}</span>
                  <Direction direction={c.direction} ticker={c.primaryTicker} size="small" />
                  <a href={`/ideas?days=365&card=${c.id}#card-${c.id}`}>{c.title}</a>
                  <span className={`tag ${c.status}`}>{c.status.replace("_", " ")}</span>
                  {r && r.closed && <span className={`small ${r.ret >= 0 ? "pos" : "neg"}`}>{r.ret >= 0 ? "+" : "−"}{Math.abs(r.ret * 100).toFixed(1)}%</span>}
                  {tr?.invalidatedAt && <span className="tag neg">invalidated</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
