import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import * as store from "@/lib/scout/store";
import ChatWindow from "./ChatWindow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ChatPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const past = await store.recentChatThreads(15).catch(() => []);
  return (
    <>
      <h1>Chat</h1>
      <ChatWindow past={past} />
    </>
  );
}
