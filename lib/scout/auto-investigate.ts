/**
 * Automatic investigations: when a fresh story on a stock with a scout card involves regulators, China or export
 * controls, a short-seller report, or related-party dealings, the scout opens an investigation on its own.
 * At most AUTO_INVESTIGATE.perDay a day, one per stock a week, and only while the day's AI budget has room
 * (a story the budget turned away is still in the 24-hour look-back after the midnight reset).
 * The findings flow into research and chat like any investigation; trade angles still go to research only on a press.
 */
import { query as q } from "../db";
import { toEt } from "../time";
import type { FeedItem } from "./newsfeed";
import * as store from "./store";

export const AUTO_INVESTIGATE = { perDay: 2, lookbackH: 24, budgetShare: 0.7, cooldownDays: 7, marker: "Auto-investigation" };

export const AUTO_TRIGGERS: Array<[string, RegExp]> = [
  ["short-seller report", /\bshort[- ]sell(er|ing) report|\bshort report\b|\b(Hindenburg|Muddy Waters|Citron|Spruce Point|Wolfpack|Grizzly Research|Culper|Fuzzy Panda|Iceberg Research|Kerrisdale|Blue Orca|Viceroy Research|J Capital|Bleecker Street|Morpheus Research|Scorpion Capital|Glasshouse)\b/i],
  ["related-party dealings", /\brelated[- ]part(y|ies)\b|\bundisclosed (relationship|transaction|ties)|\bself[- ]dealing\b|\bround[- ]tripping\b|\baccounting irregularit|\brestat(e|es|ed|ement)\b.{0,40}\b(results|financials|earnings)/i],
  ["China / export controls", /\bexport (control|curb|ban|restriction|licen[cs]e)s?\b|\bEntity List\b|\bBureau of Industry and Security\b|\bCFIUS\b|\bsanction(s|ed)?\b.{0,60}\b(China|Chinese|Russia|Iran)|\b(China|Chinese|Beijing)\b.{0,80}\b(ban|curb|probe|investigation|restrict|blacklist|sanction|retaliat|antitrust|SAMR|MOFCOM)/i],
  ["regulators", /\b(SEC|DOJ|Justice Department|FTC|FCC|FDA|CFPB|FINRA|EU Commission|European Commission|CMA|SAMR)\b.{0,60}\b(probe|investigat|subpoena|charges?|sues|lawsuit|settle|fine[sd]?|penalt|warning letter|complete response|consent decree|Wells notice|antitrust)|\bWells notice\b|\bsubpoena(ed)?\b|\bantitrust (probe|suit|lawsuit|investigation)\b/i],
];

/** Pure: why a story should be investigated, or null. */
export function autoTrigger(text: string): string | null {
  for (const [why, re] of AUTO_TRIGGERS) if (re.test(text)) return why;
  return null;
}

/** Pure: the newest story worth an automatic investigation: on a stock with a card, about one to three stocks, a trigger, not already investigated. */
export function pickStory(items: FeedItem[], now: Date, done: { symbols: Set<string>; urls: Set<string> }): { item: FeedItem; why: string } | null {
  const since = now.getTime() - AUTO_INVESTIGATE.lookbackH * 3600_000;
  const fresh = items.filter((i) => i.kind === "news" && !i.repostedAt && i.source !== "Scout price watch" && Date.parse(i.at) >= since && i.cardIds.length > 0 && i.symbols.length >= 1 && i.symbols.length <= 3);
  for (const item of fresh.slice().sort((a, b) => b.at.localeCompare(a.at))) {
    if (done.urls.has(item.url) || item.symbols.some((s) => done.symbols.has(s))) continue;
    const why = autoTrigger(`${item.headline} ${item.summary}`);
    if (why) return { item, why };
  }
  return null;
}

/** Pure: the brief an automatic investigation starts from (the first line is how the page and the cap recognise it). */
export function autoBrief(item: FeedItem, why: string): string {
  return [
    `${AUTO_INVESTIGATE.marker} (${why}) of ${item.symbols.join(", ")}: ${item.headline}`,
    `Source: ${item.source}, ${item.at} (${item.url})`,
    item.summary ? `Summary: ${item.summary}` : "",
    `The scout has card${item.cardIds.length > 1 ? "s" : ""} ${item.cardIds.map((c) => `#${c}`).join(", ")} on this stock. Check the story against primary records: who the regulator, counterparty, supplier or short seller is; what the filings, court dockets, export notices and exchange announcements actually show; what is pending and when; and which listed companies are exposed and how.`,
  ].filter(Boolean).join("\n\n");
}

/** Pure: symbols and links already investigated automatically (from the first lines of recent briefs). */
export function alreadyDone(inputs: string[]): { symbols: Set<string>; urls: Set<string> } {
  const symbols = new Set<string>();
  const urls = new Set<string>();
  for (const s of inputs) {
    const m = s.match(/^Auto-investigation \([^)]*\) of ([A-Z., ]+):/);
    if (m) for (const x of m[1].split(",")) symbols.add(x.trim());
    const u = s.match(/\nSource: [^\n]*\((https?:[^)\s]+)\)/);
    if (u) urls.add(u[1]);
  }
  return { symbols, urls };
}

/**
 * Start at most one automatic investigation. It runs in its own function call (/api/cron/investigate), so the
 * caller's time limit is not spent on it. Returns what happened, for the log.
 */
export async function maybeAutoInvestigate(now: Date, origin: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const today = toEt(now).date;
  const recent = (await q(`SELECT input, created_at FROM investigations WHERE input LIKE $1 AND created_at > now() - ($2 || ' days')::interval`, [`${AUTO_INVESTIGATE.marker} (%`, String(AUTO_INVESTIGATE.cooldownDays)])) as Array<{ input: string; created_at: string }>;
  const todayCount = recent.filter((r) => toEt(new Date(r.created_at)).date === today).length;
  if (todayCount >= AUTO_INVESTIGATE.perDay) return `auto-investigate: ${todayCount} today (cap ${AUTO_INVESTIGATE.perDay})`;
  const [settings, spend] = await Promise.all([store.loadSettings(), store.spendOn(today)]);
  if (spend.cost >= settings.dailyCapUsd * AUTO_INVESTIGATE.budgetShare) return `auto-investigate: waiting for budget ($${spend.cost.toFixed(2)} of $${settings.dailyCapUsd} spent)`;
  const { newsFeed } = await import("./newsfeed");
  const pick = pickStory(await newsFeed(now), now, alreadyDone(recent.map((r) => r.input)));
  if (!pick) return "auto-investigate: nothing to investigate";
  if (!(await store.tryLock("lock:auto-investigate", 10))) return "auto-investigate: another start is running";
  try {
    const { startInvestigation } = await import("./investigate");
    const id = await startInvestigation(autoBrief(pick.item, pick.why));
    const secret = env.CRON_SECRET?.trim();
    const res = await fetchImpl(`${origin}/api/cron/investigate?id=${id}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).catch((e: unknown) => ({ ok: false, status: 0, statusText: String(e) }) as Response);
    if (!res.ok) await q(`UPDATE investigations SET status = 'error', error = $2 WHERE id = $1`, [id, `could not start (${res.status})`]);
    return `auto-investigate: #${id} ${pick.item.symbols.join(",")} (${pick.why})${res.ok ? "" : ` failed to start: ${res.status}`}`;
  } finally {
    await store.unlock("lock:auto-investigate").catch(() => undefined);
  }
}
