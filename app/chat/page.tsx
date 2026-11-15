import SetupNotice from "@/components/SetupNotice";
import { hasDatabase } from "@/lib/db";
import { OPTIONS_UNIVERSE } from "@/config/options";
import { UNIVERSE } from "@/config/universe";
import * as store from "@/lib/scout/store";
import { addDays, toEt } from "@/lib/time";
import ChatWindow from "./ChatWindow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ChatPage() {
  if (!hasDatabase()) return <SetupNotice />;
  const since = addDays(toEt(new Date()).date, -120);
  const [past, cards, congress] = await Promise.all([store.recentChatThreads(15).catch(() => []), store.cardsSince(120).catch(() => []), store.congressTradesSince(since).catch(() => [])]);
  // Symbols the scout knows, for colouring tickers in replies (plain words in capitals stay plain).
  const tickers = [...new Set([...Object.values(UNIVERSE).flat(), ...OPTIONS_UNIVERSE, ...cards.flatMap((c) => c.card.tickers.map((t) => t.symbol)), ...congress.map((t) => t.symbol)])];
  return (
    <>
      <h1>Chat</h1>
      <ChatWindow past={past} tickers={tickers} />
    </>
  );
}
