import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { ideaMap } from "@/lib/scout/idea-map";
import IdeaMap from "./IdeaMap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MapPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const nodes = await ideaMap().catch(() => []);
  return (
    <>
      <h1>Idea map</h1>
      <p className="small secondary">Every source the scout reads, around the edge; every stock one of them points at, in the middle, with a line to each source that flags it. Stocks flagged by several sources sit nearer the centre and grow larger; a green or red ring is a long or short card. Cards from the last 30 days, filings and insider buys from the last 30, options flags from 7, Trump posts from 3, and today&apos;s news, movers, Stocktwits trending, contracts and earnings.</p>
      {nodes.length ? <IdeaMap nodes={nodes} /> : <section className="card"><p className="muted">Nothing to map yet.</p></section>}
    </>
  );
}
