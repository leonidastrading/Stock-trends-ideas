/**
 * Chat tab: a conversation with the scout's model that starts from a briefing
 * of everything the scout knows right now (its cards and their paper results,
 * rejected ideas, stories, filings, options flags, Congress trades, market
 * panels, earnings, inbox documents and the latest headlines). The briefing is
 * fixed for the life of a thread, so every turn after the first reads it from
 * the prompt cache; "New chat" builds a fresh one. Paper only: the chat can
 * discuss and suggest, never trade.
 */
import { type DailyBar, marketDataFromEnv } from "../alpaca";
import { addDays, daysBetween, fmtEt, toEt } from "../time";
import { bySymbol } from "./congress";
import { describeFlag } from "./options-flow";
import { CARD_ATTACHED } from "./chat-text";
import * as store from "./store";

export const CHAT_SYSTEM = `You are the research partner inside Trend scout, Vadim's paper-only research assistant. Below the rules is a briefing: everything the scout has logged and measured, as of the time stated. Use it as your memory.

How to answer:
- Ground answers in the briefing. Cite cards as "card #id", stories, filings and flags by name and date. Say when something is not in the briefing instead of guessing; your own background knowledge is fine for context but label it, and it may be out of date.
- Be direct and concise; lead with the answer. Use numbers. Plain text with short lists; no tables wider than four columns.
- A question can carry cards fetched when it was asked (after "--- the card as logged ---"): they are newer than the briefing, so use them for any card the briefing does not have, and never say you cannot see a card that is attached.
- A question can carry a NEWS SEARCH block: Google News headlines from the last 7 days on the question's key words, fetched when it was asked. Use them for events the briefing does not cover, cite the outlet and date, say plainly when nothing relevant came up, and never say you cannot browse when the block is there. Headlines are not proof: say when only one outlet reports something.
- A question can carry a LIVE DATA block (price now, recent moves, the last week's headlines), fetched when it was asked. It is newer than the briefing: use it for anything about today's price or recent news, and never say you cannot see the current price when it is there.
- Write stock tickers in capitals (NVDA). Spell out any other acronym the first time you use it, with the acronym in brackets ("Intelligent Agreement Management (IAM)"), so a product or program is not mistaken for a ticker.
- When asked for trade ideas, give direction, ticker, catalyst and date, what would prove it wrong, how late it is, and what to check next. Be honest about weak evidence and about the base rate: most ideas do not beat SPY.
- The scout never places, changes or cancels orders, and you cannot either. You can suggest Vadim paste an idea into "I noticed something" to have it researched and scored as his.
- Do not reveal API keys, tokens or settings values.`;

const cut = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const usd = (v: number) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

/** Everything the scout knows now, as text (each section bounded). Failures leave a section out rather than failing the chat. */
export async function buildBriefing(now = new Date()): Promise<string> {
  const today = toEt(now).date;
  const parts: string[] = [`BRIEFING as of ${fmtEt(now)} (today is ${today}, US Eastern).`];
  const safe = async (title: string, f: () => Promise<string | null>) => {
    try {
      const body = await f();
      if (body) parts.push(`\n## ${title}\n${body}`);
    } catch (err) {
      parts.push(`\n## ${title}\n(unavailable: ${cut(err instanceof Error ? err.message : String(err), 120)})`);
    }
  };
  const data = marketDataFromEnv();

  await safe("Market and rates (vs previous close)", async () => {
    const m = await store.cacheGet<Array<{ label: string; value: string; changePct: number | null }>>("market");
    const b = await store.cacheGet<{ asOf: string; stocks: number; advancing: number; declining: number; highs: number; lows: number; mood: number; moodLabel: string }>("breadth");
    const lines = (m?.data ?? []).map((r) => `- ${r.label}: ${r.value}${r.changePct === null ? "" : r.label.includes("Treasury") ? ` (${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)} pts)` : ` (${pct(r.changePct)})`}`);
    if (b?.data) lines.push(`- Breadth on ${b.data.asOf} across the scout's ${b.data.stocks} stocks: ${b.data.advancing} up / ${b.data.declining} down, ${b.data.highs} new 52-week highs / ${b.data.lows} lows; mood ${b.data.mood}/100 (${b.data.moodLabel})`);
    return lines.length ? `${lines.join("\n")}${m ? `\n(as of ${fmtEt(m.updatedAt)})` : ""}` : null;
  });

  await safe("Earnings in the next 5 business days (largest first)", async () => {
    const e = await store.cacheGet<{ total: number; rows: Array<{ date: string; symbol: string; name: string; eps: string | null; time: string }> }>("earnings");
    return e?.data ? `${e.data.total} companies report. Largest:\n${e.data.rows.map((r) => `- ${r.symbol} (${cut(r.name, 40)}) ${r.date} ${r.time}${r.eps ? `, EPS est. ${r.eps}` : ""}`).join("\n")}` : null;
  });

  // Cards with paper results.
  const cards = await store.cardsSince(45).catch(() => [] as store.StoredCard[]);
  await safe("Thesis cards, last 45 days (newest first), with paper results", async () => {
    if (!cards.length) return "None yet.";
    const tracks = new Map((await store.allTracks()).map((t) => [t.cardId, t]));
    const open = [...tracks.values()].filter((t) => t.entryPrice && !t.exitPrice).map((t) => t.symbol);
    const bars = open.length ? await store.loadBars([...new Set([...open, "SPY"])], addDays(today, -10), today) : [];
    const last = new Map<string, DailyBar>();
    for (const b of bars) if (!last.get(b.symbol) || b.date > last.get(b.symbol)!.date) last.set(b.symbol, b as DailyBar);
    return cards.slice(0, 80).map((c) => {
      const t = tracks.get(c.id);
      let paper = "not tracked";
      if (t?.excluded) paper = `excluded from scoring (${cut(t.excluded, 60)})`;
      else if (t?.entryPrice && t.exitPrice) {
        const r = (t.exitPrice / t.entryPrice - 1) * (t.direction === "long" ? 100 : -100);
        const spy = t.spyEntry && t.spyExit ? (t.spyExit / t.spyEntry - 1) * 100 : null;
        paper = `closed ${t.exitDate} (${t.exitReason}): ${pct(r)}${spy !== null ? `, SPY ${pct(spy)}` : ""}`;
      } else if (t?.entryPrice) {
        const now1 = last.get(t.symbol)?.c, spyNow = last.get("SPY")?.c;
        const r = now1 ? (now1 / t.entryPrice - 1) * (t.direction === "long" ? 100 : -100) : null;
        const spy = spyNow && t.spyEntry ? (spyNow / t.spyEntry - 1) * 100 : null;
        paper = `open since ${t.entryDate} at $${t.entryPrice.toFixed(2)}${r !== null ? `, now ${pct(r)}` : ""}${spy !== null ? ` vs SPY ${pct(spy)}` : ""}, deadline ${t.deadlineDate}`;
      } else if (t) paper = `waiting for entry (deadline ${t.deadlineDate})`;
      const k = c.card;
      return `- card #${c.id} ${c.createdAt.slice(0, 10)} [${c.status}] ${c.origin === "human" ? "(Vadim's) " : ""}${c.direction} ${k.tickers.map((x) => x.symbol).join("/")}: ${cut(k.title, 90)}. Confidence ${k.confidence}. Catalyst: ${cut(k.catalyst.what, 80)} (${k.catalyst.date || "no date"}). Why not priced: ${cut(k.why_not_priced, 160)} Invalidation: ${cut(k.invalidation, 110)} Paper: ${paper}.`;
    }).join("\n");
  });

  await safe("Ideas looked at and rejected, last 7 days", async () => {
    const cs = (await store.candidatesSince(7)).filter((c) => c.outcome !== "card").slice(0, 30);
    return cs.length ? cs.map((c) => `- ${c.createdAt.slice(0, 10)} "${cut(c.term, 60)}": ${c.outcome}${c.reason ? `, ${cut(c.reason, 110)}` : ""}`).join("\n") : null;
  });

  await safe("Stories the story desk is following, last 10 days (latest read of each)", async () => {
    const ev = await store.storyEventsSince(addDays(today, -10));
    const latest = new Map<string, store.StoryEvent>();
    for (const e of ev) latest.set(e.key, e);
    const rows = [...latest.values()].sort((a, b) => b.etDate.localeCompare(a.etDate)).slice(0, 25);
    return rows.length ? rows.map((e) => `- ${e.etDate} ${e.symbols.join("/")} stage ${e.stage}: ${cut(e.summary, 260)}${e.people.length ? ` (people: ${e.people.join(", ")})` : ""}`).join("\n") : null;
  });

  await safe("Filings, last 14 days", async () => {
    const from = addDays(today, -14);
    const [buys, alerts] = await Promise.all([store.insiderBuysSince(from), store.filingAlertsSince(from)]);
    const lines = [
      ...buys.slice(0, 20).map((b) => `- insider buy ${b.filed} ${b.symbol ?? "?"}: ${cut(b.owner, 30)} (${cut(b.role, 25)}) ${b.value ? usd(b.value) : "?"}${b.pctIncrease !== null ? `, +${b.pctIncrease}% to holding` : ""}${b.routine === false ? ", opportunistic" : ""}`),
      ...alerts.slice(0, 20).map((a) => `- ${a.kind} ${a.filed} ${a.symbol ?? ""} ${cut(a.company, 40)}${a.kind === "13D" ? ` by ${cut(a.filer, 40)}` : `: ${cut(a.items.join("; "), 120)}`}`),
    ];
    return lines.length ? lines.join("\n") : null;
  });

  await safe("Unusual options positions, last 7 days (open interest; the side is unknown)", async () => {
    const f = await store.optionsFlagsSince(addDays(today, -7));
    return f.length ? f.slice(0, 20).map((x) => `- ${x.date}: ${describeFlag(x)}`).join("\n") : null;
  });

  await safe("Congress trades (House reports), last 30 days by filing date", async () => {
    const since = addDays(today, -30);
    const t = await store.congressTradesSince(since);
    if (!t.length) return null;
    const most = bySymbol(t, since).slice(0, 12).map((a) => `- ${a.symbol}: bought by ${a.buyers.length} (${cut(a.buyers.join(", "), 80)}), sold by ${a.sellers.length}${a.cluster ? " [cluster]" : ""}`);
    const latest = t.slice(0, 15).map((x) => `- ${x.filed} ${x.member}: ${x.tx} ${x.symbol}${x.assetType === "option" ? " options" : ""} ${x.amount} (traded ${x.txDate}, ${daysBetween(x.txDate, x.filed)}d late)`);
    return `Most bought:\n${most.join("\n")}\nLatest:\n${latest.join("\n")}`;
  });

  await safe("Trump's Truth Social posts judged market-relevant, last 3 days (most urgent first)", async () => {
    const posts = (await store.truthPostsSince(new Date(now.getTime() - 3 * 86400_000).toISOString(), true)).filter((p) => p.read);
    return posts.length ? posts.sort((a, b) => b.read!.urgency - a.read!.urgency || b.at.localeCompare(a.at)).slice(0, 15).map((p) => `- ${fmtEt(p.at)} urgency ${p.read!.urgency}/5, ${p.read!.direction} ${p.read!.tickers.join("/") || p.read!.sectors.join("/")}: ${cut(p.read!.summary, 200)} Post: "${cut(p.text, 220)}"`).join("\n") : null;
  });

  await safe("Prediction markets (Polymarket): biggest odds moves among the busiest markets", async () => {
    const m = await store.cacheGet<Array<{ question: string; yes: number; dayChange: number | null; weekChange: number | null; endDate: string | null }>>("polymarket");
    return m?.data?.length ? m.data.map((r) => `- ${cut(r.question, 110)}: ${r.yes}% yes (${r.dayChange ?? "?"} pts 1d, ${r.weekChange ?? "?"} pts 7d)${r.endDate ? `, ends ${r.endDate}` : ""}`).join("\n") : null;
  });

  await safe("Down drift: stocks still falling days after bad news (Drift tab)", async () => {
    const d = await store.cacheGet<{ setups: import("./drift").DriftSetup[] }>("drift");
    return d?.data?.setups?.length ? d.data.setups.slice(0, 12).map((s) => `- ${s.symbol} ${s.stage}: ${s.dayPct}% on ${s.eventDate} (${s.eventKind}: ${cut(s.eventHeadline, 90)}), ${s.sincePct}% more over ${s.daysAfter} trading days (${s.sinceVsSpy}% vs SPY), ${s.badAfter} bad headlines since`).join("\n") : null;
  });

  await safe("Rumors from fringe and conspiracy sources (UNVERIFIED claims, Rumors tab; never treat as fact)", async () => {
    const { rumorsSince } = await import("./rumors");
    const rs = (await rumorsSince(7, 200)).filter((r) => r.specificity >= 3).slice(0, 15);
    return rs.length ? rs.map((r) => `- [${r.category}${r.tickers.length ? ` ${r.tickers.join(",")}` : ""}] ${cut(r.claim, 160)}${r.mainstream ? ` (mainstream: ${r.mainstream.headlines7d} headlines, ${r.mainstream.matches.length ? "similar reported" : "nothing similar"})` : ""}`).join("\n") : null;
  });

  await safe("Federal contracts, latest large awards to listed companies", async () => {
    const c = await store.cacheGet<Array<{ ticker: string; agency: string; amount: number; date: string; description: string }>>("contracts");
    return c?.data?.length ? c.data.slice(0, 8).map((r) => `- ${r.date} ${r.ticker}: ${usd(r.amount)} from ${cut(r.agency, 50)}: ${cut(r.description, 90)}`).join("\n") : null;
  });

  await safe("Buzz (chatter, news pace, Stocktwits trending), out of 20", async () => {
    const b = await store.cacheGet<Array<{ symbol: string; score: number; parts: string }>>("buzz");
    return b?.data?.length ? b.data.map((r) => `- ${r.symbol} ${r.score}/20 (${r.parts})`).join("\n") : null;
  });

  const work = await import("./known").then(({ recentWork }) => recentWork(now)).catch(() => null);
  await safe("The user's investigations, last 30 days (Investigate tab: follow-the-money reports from public records)", async () => (work?.investigations.length ? work.investigations.map((l) => `- ${l}`).join("\n") : null));
  await safe("Themes: what the user's sources agree on (latest readings)", async () => (work?.themes.length ? work.themes.map((l) => `- ${l}`).join("\n") : null));
  await safe("Dots: second-order ideas from what is changing (latest runs)", async () => (work?.dots.length ? work.dots.map((l) => `- ${l}`).join("\n") : null));
  await safe("Your websites: the latest articles and research reports read (last 7 days)", async () => (work?.sites.length ? work.sites.map((l) => `- ${l}`).join("\n") : null));
  await safe("Lawsuits (Court tab): securities class actions and ITC patent cases", async () => (work?.court.length ? work.court.map((l) => `- ${l}`).join("\n") : null));

  await safe("Documents received in the inbox (newest first)", async () => {
    const files = await store.inboxRecent(10);
    return files.length ? files.map((f) => `- ${f.readAt.slice(0, 10)} ${f.path}: ${cut(JSON.stringify(f.result ?? {}), 140)}`).join("\n") : null;
  });

  await safe("Latest headlines (Alpaca news, last 36 hours)", async () => {
    if (!data) return null;
    const end = now, start = new Date(now.getTime() - 36 * 3600_000);
    const cardSyms = [...new Set(cards.slice(0, 40).flatMap((c) => c.card.tickers.map((t) => t.symbol)))].slice(0, 40);
    const [general, mine] = await Promise.all([data.getNews([], start, end, 60).catch(() => []), cardSyms.length ? data.getNews(cardSyms, start, end, 60).catch(() => []) : Promise.resolve([])]);
    const seen = new Set<number>();
    const items = [...mine, ...general].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 90);
    return items.length ? items.map((n) => `- ${fmtEt(n.ts)} [${n.symbols.slice(0, 4).join(",")}] ${cut(n.headline, 150)} (${n.source})`).join("\n") : null;
  });

  return parts.join("\n");
}

// ------------------------------------------------------------------- turn

/** Longest message the chat takes (about 50,000 words: a long report or transcript). */
export const CHAT_MAX_CHARS = 300_000;
/** Older long messages are shortened to this when sent back as history, so one big paste is not paid for on every later turn. */
const OLD_MESSAGE_CHARS = 8_000;

/** Model history for the API: the last turns as plain text, starting with a user message. The last 4 messages go in whole. */
export function historyFor(messages: store.ChatMessage[], keep = 30): Array<{ role: "user" | "assistant"; content: string }> {
  const last = messages.slice(-keep);
  const h = last.map((m, i) => ({
    role: m.role,
    content: i < last.length - 4 && m.content.length > OLD_MESSAGE_CHARS ? `${m.content.slice(0, OLD_MESSAGE_CHARS)}\n[… ${(m.content.length - OLD_MESSAGE_CHARS).toLocaleString("en-US")} more characters were in this earlier message; shortened here]` : m.content,
  }));
  while (h.length && h[0].role !== "user") h.shift();
  return h;
}

/**
 * One chat turn, streamed: calls `onText` with each piece of the reply and resolves with the whole reply.
 * The system prompt and the thread's briefing are both cached, so later turns pay for them at the cache rate.
 */
export async function chatTurn(thread: store.ChatThread, userText: string, onText: (t: string) => void, now = new Date()): Promise<{ text: string; costUsd: number | null }> {
  const [{ default: Anthropic }, { callCost }, { FALLBACK_MODELS }] = await Promise.all([import("@anthropic-ai/sdk"), import("@/config/scout"), import("./llm")]);
  const settings = await store.loadSettings();
  const today = toEt(now).date;
  const spend = await store.spendOn(today);
  if (spend.cost >= settings.dailyCapUsd) throw new Error(`daily AI spending cap reached ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd}); raise it on Settings or wait until midnight ET`);
  const client = new Anthropic();
  const model = settings.model;
  const base = {
    model,
    max_tokens: 16000,
    system: [
      { type: "text" as const, text: CHAT_SYSTEM, cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: thread.briefing, cache_control: { type: "ephemeral" as const } },
    ],
    messages: [...historyFor(thread.messages), { role: "user" as const, content: userText }],
    output_config: { effort: "medium" as const },
  };
  let sent = false;
  const run = async (withFallback: boolean) => {
    const stream = client.beta.messages.stream(withFallback ? { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : base);
    let text = "";
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        text += ev.delta.text;
        sent = true;
        onText(ev.delta.text);
      }
    }
    return { text, final: await stream.finalMessage() };
  };
  let out: Awaited<ReturnType<typeof run>>;
  try {
    out = await run(FALLBACK_MODELS.has(model));
  } catch (err) {
    // If the account rejects the refusal-fallback option before any text went out, send the same request without it.
    const msg = err instanceof Error ? err.message : String(err);
    if (sent || !(err instanceof Anthropic.BadRequestError) || !/fallback|beta/i.test(msg)) throw err;
    out = await run(false);
  }
  const u = out.final.usage;
  const usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens };
  const costUsd = callCost(model, usage);
  await store.logLlmCall({ etDate: today, model, purpose: "chat", usage, costUsd, ok: out.final.stop_reason !== "refusal" });
  let text = out.text;
  const note = out.final.stop_reason === "refusal" ? "\n\n(The model declined to answer this.)" : out.final.stop_reason === "max_tokens" ? "\n\n(Reply cut off at the length limit.)" : "";
  if (note) { text += note; onText(note); }
  return { text, costUsd };
}

/** Pure: the message for a question asked from a card: the question first, then the whole card and its paper track. */
export function cardQuestion(c: store.StoredCard, track: store.Track | null, question: string): string {
  const head = `About card #${c.id} (${c.direction} ${c.primaryTicker}: ${c.title}): ${question.trim()}`;
  const details = { id: c.id, logged: c.createdAt, status: c.status, gateNotes: c.gateNotes, card: c.card, paperTrack: track };
  return `${head}${CARD_ATTACHED}${JSON.stringify(details, null, 1).slice(0, 20_000)}`;
}
