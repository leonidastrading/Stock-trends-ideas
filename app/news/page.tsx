import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { newsFeed } from "@/lib/scout/newsfeed";
import NewsFeed from "./NewsFeed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function NewsPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const items = await newsFeed().catch(() => []);
  return (
    <>
      <h1>News</h1>
      <NewsFeed initial={items} />
    </>
  );
}
