/**
 * The file format outside bots use to send ideas to the scout, and the prompt
 * to give such a bot. One source of truth for the Inbox tab and the README.
 */
import { KINDS } from "@/config/scout";

export const INBOX_EXAMPLE = {
  bot: "my-research-bot",
  generated_at: "2026-11-16T13:05:00Z",
  ideas: [
    {
      term: "Coinbase retail slump",
      observation: "Robinhood reported on 2026-11-13 that its October crypto trading volume fell 48% from September; bitcoin fell 9% over the same month. Coinbase earns most of its revenue from retail trading fees and reports Q4 results in February.",
      kind: "second_order",
      tickers: ["COIN"],
      company: "Coinbase Global, Inc.",
      direction: "short",
      catalyst_date: "2027-02-12",
      horizon_days: 30,
      invalidation: "US retail crypto volumes recover above September levels in Robinhood's November report",
      confirmed: "Robinhood's 48% figure is from its own monthly metrics release",
      sources: ["https://investors.robinhood.com/..."],
    },
  ],
};

export const INBOX_FIELDS: Array<{ name: string; required: boolean; about: string }> = [
  { name: "term", required: true, about: "a short name for the idea, 2–8 words" },
  { name: "observation", required: true, about: "what changed, with numbers and dates, in plain sentences (5–2,000 characters). Only facts the bot actually found; no guesses presented as facts" },
  { name: "kind", required: true, about: `one of: ${KINDS.join(", ")}` },
  { name: "tickers", required: true, about: "US exchange-listed symbols, most directly exposed first (ADRs for foreign companies; no OTC-only or home-market symbols); [] if unsure" },
  { name: "company", required: false, about: "the first ticker's company name, so the scout can check the symbol still means that company" },
  { name: "direction", required: false, about: "long or short; leave out if the bot has no view" },
  { name: "catalyst_date", required: false, about: "YYYY-MM-DD of the next dated event that should move it" },
  { name: "horizon_days", required: false, about: "how many days the idea needs to play out (1–180)" },
  { name: "invalidation", required: false, about: "what would prove the idea wrong" },
  { name: "confirmed", required: false, about: "which facts are confirmed and by whom" },
  { name: "sources", required: false, about: "up to 10 links the facts came from" },
];

export function botPrompt(repo: string | null, path: string): string {
  const where = repo ? `the GitHub repository https://github.com/${repo}, folder ${path}/ on the default branch` : `the GitHub repository and folder Vadim gives you (folder "${path}/")`;
  return `Once a day (and whenever you find something worth acting on), write your trade ideas to a JSON file and commit it to ${where}.

File name: ${path}/YYYY-MM-DD-<your-name>.json (for example ${path}/2026-11-16-my-research-bot.json). Use a new file name for each upload; never edit or delete a file you already uploaded.

The file is one JSON object, UTF-8, nothing else in the file:
${JSON.stringify(INBOX_EXAMPLE, null, 2)}

Fields of each idea:
${INBOX_FIELDS.map((f) => `- "${f.name}"${f.required ? " (required)" : " (optional)"}: ${f.about}`).join("\n")}

Rules:
- At most 12 ideas per file, the most concrete and checkable first; one idea per distinct thesis.
- Put the facts, numbers and dates in "observation"; a reader with no other context should understand why the idea might move the stock.
- Prefer ideas the market may not have priced yet: something changed recently and few are talking about it. Skip general market commentary and recaps of old news.
- Symbols change hands (EchoStar moved from SATS to ECHO in 2026): check each ticker is the company's current US symbol and give the company name.
- Valid JSON only: double quotes, no comments, no trailing commas.

The scout reads each new file within the hour, researches every idea with its own data, logs a thesis card, and scores the ideas on paper against SPY as "Your bot". It never places orders.`;
}
