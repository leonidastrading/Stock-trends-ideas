/**
 * Where a card's idea came from, in one or two words ("YouTube", "Discord", "News scan", "Rumors", "Insider buy"),
 * worked out from the research term the card came from and the observation it was given (an inbox document's file
 * name, a website's name, the stream file).
 */
import { playerOf } from "./scoreboard";

const DOC_KINDS: Array<[RegExp, string]> = [
  [/youtube|\byt\b/i, "YouTube"], [/discord/i, "Discord"], [/reddit|\br-|wsb|wallstreetbets/i, "Reddit"], [/stocktwits/i, "Stocktwits"],
  [/twitter|\bx-|tweet/i, "X"], [/telegram/i, "Telegram"], [/podcast|spotify/i, "Podcast"], [/substack|newsletter/i, "Newsletter"],
  [/meet[- ]?kevin|alpha[- ]?report/i, "Meet Kevin"], [/email|gmail|mail/i, "Email"], [/transcript/i, "Transcript"], [/earnings/i, "Earnings"],
];

/** Pure: the label of the document or site an observation names, if any. */
export function docLabel(observation: string | null | undefined): string | null {
  const o = observation ?? "";
  return /From the inbox document "([^"]+)"/.exec(o)?.[1] ?? /\(From ([^;)]{2,60});/.exec(o)?.[1] ?? null;
}

/** Pure: one or two words for where the idea came from, and a longer note for the hover. */
export function originTag(origin: "scout" | "human", term: string | undefined, observation?: string | null): { tag: string; note: string } {
  const t = (term ?? "").toLowerCase();
  const player = playerOf(origin, term);
  const doc = docLabel(observation);
  const kind = (s: string | null) => (s ? DOC_KINDS.find(([re]) => re.test(s))?.[1] ?? null : null);
  switch (player) {
    case "inbox_bot": return { tag: kind(doc) ?? kind(term ?? "") ?? "Inbox doc", note: `From your bot's inbox${doc ? `: ${doc}` : ""}` };
    case "stream_host": return { tag: "Stream host", note: "From the daily stream file (host)" };
    case "stream_agent": return { tag: "Stream agent", note: "From the daily stream file (agent)" };
    case "scout_story": return { tag: "News scan", note: "The story desk's news scan" };
    case "scout_options": return { tag: "Options", note: "Unusual options positions" };
    case "scout_filings": return t.startsWith("insider+congress") ? { tag: "Insiders+Congress", note: "Insiders and members of Congress buying" } : t.startsWith("insider") ? { tag: "Insider buy", note: "SEC Form 4 insider purchase" } : t.startsWith("congress") ? { tag: "Congress", note: "Congress trades" } : { tag: "SEC filing", note: "SEC filing (8-K, 13D, late filing)" };
    case "scout_truth": return { tag: "Trump post", note: "Trump's Truth Social posts" };
    case "scout_sites": return { tag: doc ? doc.slice(0, 18) : "Website", note: `One of your websites${doc ? `: ${doc}` : ""}` };
    case "scout_drift": return { tag: "Down drift", note: "Down drift after bad news" };
    case "scout_rumors": return { tag: "Rumors", note: "A rumor you sent to research" };
    case "scout_investigations": return { tag: "Investigation", note: "One of your investigations" };
    case "scout_themes": return { tag: "Themes", note: "Themes: what your sources agree on" };
    case "scout_trend":
      if (t.startsWith("dots:")) return { tag: "Dots", note: "Dots: a second-order idea" };
      if (t.startsWith("court:")) return { tag: "Court", note: "A lawsuit on the Court tab" };
      if (t.startsWith("site:")) return { tag: "Website", note: "One of your websites" };
      return { tag: "Trend scan", note: "The trend desk's daily scan" };
    default:
      if (t.startsWith("dots:")) return { tag: "Dots", note: "Dots: a second-order idea, researched by you" };
      if (t.startsWith("court:")) return { tag: "Court", note: "A lawsuit on the Court tab, researched by you" };
      if (/\bfda\b/.test(t)) return { tag: "Pharma", note: "An FDA date on the Pharma tab, researched by you" };
      if (/^(earnings|drift):/.test(t)) return { tag: "Drift", note: "The Drift tab, researched by you" };
      return { tag: observation && /uploaded image/i.test(observation) ? "Your image" : "Your note", note: "Something you noticed" };
  }
}
