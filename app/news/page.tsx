import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { newsFeed } from "@/lib/scout/newsfeed";
import { topNews, type TopNews as Top } from "@/lib/scout/top-news";
import NewsFeed from "./NewsFeed";
import TopNews from "./TopNews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NewsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const items = await newsFeed().catch(() => []);
  const top = await topNews(items).catch((): Top => ({ at: new Date().toISOString(), by: "rules", picks: [] }));
  return (
    <>
      <h1>News</h1>
      <TopNews top={top} />
      <NewsFeed initial={items} />
    </>
  );
}
