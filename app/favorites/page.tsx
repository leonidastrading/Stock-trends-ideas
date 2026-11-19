import CardActions from "@/components/CardActions";
import CardView from "@/components/CardView";
import { CollapseAll } from "@/components/CardCollapse";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { opposingCalls } from "@/lib/scout/calendar";
import * as store from "@/lib/scout/store";
import { swingConfigured } from "@/lib/scout/swing";
import { fmtEt } from "@/lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The cards you starred, most recently starred first. */
export default async function FavoritesPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const favs = await store.favorites();
  const ids = new Set(favs.map((f) => f.cardId));
  const [all, tracks, fb, reviews, recent] = await Promise.all([store.allCards(), store.allTracks(), store.latestFeedback(), store.allReviews(), store.cardsSince(120)]);
  const byId = new Map(all.filter((c) => ids.has(c.id)).map((c) => [c.id, c]));
  const t = new Map(tracks.map((x) => [x.cardId, x]));
  const opp = opposingCalls(recent, tracks);
  const sw = swingConfigured();
  const shown = favs.filter((f) => byId.has(f.cardId));
  return (
    <>
      <h1>★ Favorites</h1>
      <p className="small secondary">Cards you starred, most recently starred first. Tap ☆ on any card to add it here, ★ to take it off. Starring changes nothing about the card or its scoring.</p>
      {shown.length > 0 && <div className="toolbar"><CollapseAll /><span className="small muted">{shown.length} card{shown.length === 1 ? "" : "s"}</span></div>}
      {shown.map((f) => {
        const c = byId.get(f.cardId)!;
        const tr = t.get(c.id) ?? null;
        return (
          <div key={c.id}>
            <div className="small muted from-line">Starred {fmtEt(f.addedAt)} ET</div>
            <CardView c={c} track={tr} feedback={fb.get(`card:${c.id}`) ?? null} opposing={opp.get(c.id)} review={reviews.get(c.id) ?? null} actions={<CardActions cardId={c.id} canSend={c.status !== "not_promoted"} sent={!!tr?.tappedAt} open={!!tr && !tr.exitDate && !tr.invalidatedAt} swingConfigured={sw} excluded={!!tr?.excluded} />} />
          </div>
        );
      })}
      {shown.length === 0 && <section className="card"><p className="muted">No favorites yet. Tap the ☆ next to a card&apos;s number on Ideas (or anywhere a card is shown) to add it here.</p></section>}
    </>
  );
}
