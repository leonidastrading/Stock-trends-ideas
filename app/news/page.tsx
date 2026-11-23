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
  if (!hasDatabase()) return <SetupNotice />;
  const items = await newsFeed().catch(() => []);
  const [top, cards] = await Promise.all([
    topNews(items).catch((): Top => ({ at: new Date().toISOString(), by: "rules", picks: [] })),
    store.cardBriefsSince(180).catch(() => [] as store.CardBrief[]),
  ]);
  return (
    <>
      <h1>News</h1>
      <TopNews top={top} cards={cards} />
      <NewsFeed initial={items} />
    </>
  );
}
