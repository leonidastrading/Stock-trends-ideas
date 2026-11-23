import { headers } from "next/headers";
import { after } from "next/server";
import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { newsFeed } from "@/lib/scout/newsfeed";
import * as store from "@/lib/scout/store";
import { topNews, type TopNews as Top } from "@/lib/scout/top-news";
import NewsFeed from "./NewsFeed";
import TopNews from "./TopNews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NewsPage() {
  const host = (await headers()).get("host");
  if (!hasDatabase()) return <SetupNotice />;
  const items = await newsFeed().catch(() => []);
  const [top, cards] = await Promise.all([
    topNews(items).catch((): Top => ({ at: new Date().toISOString(), by: "rules", picks: [] })),
    store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]),
  ]);
  // No fresh AI pick (the cron rests 8 PM to 6 AM ET): this visit starts one, at most every half hour.
  if (top.by === "rules" && host) after(() => import("@/lib/scout/jobs").then(({ startJob }) => startJob(`https://${host}`, "/api/cron/job/topnews", "lock:job:topnews", 30)).catch(() => undefined));
  return (
    <>
      <h1>News</h1>
      <TopNews top={top} cards={cards} />
      <NewsFeed initial={items} />
    </>
  );
}
