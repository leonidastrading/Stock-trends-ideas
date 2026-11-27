/**
 * Primary sources for the story desk: the company's own words, read the minute they are public.
 *
 * The desk used to wait for headlines to pile up (three mainstream outlets) before it read a story, so a chief
 * executive's exit filed at 7:30 AM was first read in the evening (Nutanix, Nov 25 2026). But the news is public the
 * moment the company files it: the SEC's live list of 8-Ks names each filing's items within minutes, and the filing
 * itself says who is leaving, what is restated, what was impaired. This reads the filing and hands it to the desk at
 * once, with its text, no headline count and no price move needed.
 *
 * Which filings: an 8-K with an item that is news by itself (past financials no longer reliable, a cybersecurity
 * incident, restructuring, an impairment, a delisting notice, a material agreement ended, the auditor changing), and
 * an officer change (item 5.02) only when the filing's text says the chief executive or finance chief is leaving
 * (most 5.02s are directors and pay plans). Results (item 2.02) alone are the earnings desk's. Stocks under $5 are
 * left out. Each filing is read once; a few per pass and per day, so the AI budget is not spent on filings alone.
 * A company press release that is not a filing reaches the desk through its other early path (a shock headline with
 * the stock already moving); its text is attached the same way.
 */
import type { MarketData, NewsItem } from "../alpaca";
import { getText } from "../http";
import { htmlText } from "../sources/site";
import { toEt } from "../time";
import * as store from "./store";

export const PRIMARY = { perRun: 2, perDay: 12, minPrice: 5, freshMinutes: 180, docChars: 7000, look: 25 };

/** 8-K items that are news by themselves, in plain words. */
export const MATERIAL_ITEMS: Record<string, string> = {
  "4.02": "past financial statements can no longer be relied on", "1.05": "a material cybersecurity incident", "2.05": "restructuring or exit costs", "2.06": "a material impairment",
  "3.01": "a delisting notice", "1.02": "a material agreement terminated", "4.01": "the auditor changed", "1.03": "bankruptcy or receivership", "2.04": "a debt obligation accelerated",
};

const TOP_JOB = "chief executive officer|chief executive|ceo|chief financial officer|chief financial|cfo|principal executive officer|principal financial officer";
const LEAVING = "resign\\w*|retir\\w*|step(?:s|ped|ping)? down|terminat\\w*|depart\\w*|separat\\w*|ceas\\w* to serve|will leave|is leaving|left the company|remov\\w*|transition\\w* (?:out|from)|succeed\\w*|successor";

/** Pure: the items an "SEC 8-K" news item names ("SEC filing, items 5.02, 2.02, 9.01."). */
export const itemsOf = (n: Pick<NewsItem, "summary">): string[] => [...new Set([...(n.summary ?? "").matchAll(/\b(\d\.\d\d)\b/g)].map((m) => m[1]))];

/**
 * Pure: which top officer a filing says is leaving, or null. The job and a leaving word have to sit in the same
 * sentence; an appointment, a director's exit or a pay plan (most item 5.02 filings) is not one.
 */
export function topOfficerLeaving(text: string): "chief executive" | "finance chief" | null {
  const body = text.replace(/\s+/g, " ");
  for (const sentence of body.split(/(?<=[.;])\s+/)) {
    const job = new RegExp(`\\b(${TOP_JOB})\\b`, "i").exec(sentence);
    if (!job || !new RegExp(`\\b(?:${LEAVING})\\b`, "i").test(sentence)) continue;
    // "appointed X as Chief Executive Officer" with no one leaving in the same sentence is a hire, not an exit.
    if (/\bappoint\w*|\bnamed\b|\belect\w*|\bhir\w*|\bpromot\w*/i.test(sentence) && !/\bresign\w*|\bretir\w*|\bstep(?:s|ped|ping)? down|\bterminat\w*|\bdepart\w*|\bsucceed\w*|\bsuccessor/i.test(sentence)) continue;
    return /financial/i.test(job[1]) || /^cfo$/i.test(job[1]) ? "finance chief" : "chief executive";
  }
  return null;
}

export interface PrimaryRead { what: string; url: string; text: string }

/** Pure: why a filing is news by itself, from its items and its text (null: not one the desk is handed). */
export function materialReason(items: string[], text: string): string | null {
  const named = items.filter((i) => MATERIAL_ITEMS[i]).map((i) => MATERIAL_ITEMS[i]);
  const officer = items.includes("5.02") ? topOfficerLeaving(text) : null;
  const all = [...(officer ? [`the ${officer} is leaving`] : []), ...named];
  return all.length ? all.join("; ") : null;
}

/** Pure: the live 8-Ks worth opening: recent, with an item that can be news by itself, newest first. */
export function filingsToOpen(items: NewsItem[], now: Date, cfg = PRIMARY): NewsItem[] {
  const since = now.getTime() - cfg.freshMinutes * 60000;
  return items
    .filter((n) => n.source === "SEC 8-K" && n.symbols.length === 1 && Date.parse(n.ts) >= since && itemsOf(n).some((i) => i === "5.02" || MATERIAL_ITEMS[i]))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, cfg.look);
}

/** The filing's own text: the 8-K body, then its press-release exhibit when it has one. Best effort; null when unreadable. */
export async function filingText(indexUrl: string, ua: string, fetchImpl?: typeof fetch, max = PRIMARY.docChars): Promise<string | null> {
  const base = indexUrl.replace(/\/[^/]*$/, "");
  if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+$/.test(base)) return null;
  const h = { "user-agent": ua, accept: "application/json, text/html, */*" };
  const idx = JSON.parse(await getText(`${base}/index.json`, { headers: h, fetchImpl, cacheMs: 3600_000, minIntervalMs: 150, timeoutMs: 12_000 })) as { directory?: { item?: Array<{ name: string }> } };
  const names = (idx.directory?.item ?? []).map((x) => x.name).filter((n) => /\.html?$/i.test(n) && !/index/i.test(n));
  const exhibit = (n: string) => /ex-?\d|exhibit|dex\d/i.test(n);
  const files = [...names.filter((n) => !exhibit(n)).slice(0, 1), ...names.filter((n) => /ex-?99|exhibit-?99|ex99|dex99/i.test(n)).slice(0, 1)];
  const parts: string[] = [];
  for (const f of files) {
    const html = await getText(`${base}/${f}`, { headers: { ...h, accept: "text/html" }, fetchImpl, cacheMs: 3600_000, minIntervalMs: 150, timeoutMs: 15_000 }).catch(() => "");
    const text = htmlText(html).replace(/\s+/g, " ").trim();
    // The body starts at its first item (the cover page before it is boilerplate).
    const at = exhibit(f) ? 0 : Math.max(0, text.search(/\bItem\s+\d\.\d\d\b/));
    if (text.length > 200) parts.push(text.slice(at, at + (exhibit(f) ? max * 0.6 : max * 0.5)));
  }
  return parts.length ? parts.join("\n\n").slice(0, max) : null;
}

/**
 * The filings to hand the desk now: each opened once, read, and kept when it is news by itself and the stock is
 * $5 or more. At most a few per pass and per day.
 */
export async function primaryFilings(items: NewsItem[], deps: { data: MarketData | null; env: NodeJS.ProcessEnv; now: Date; fetchImpl?: typeof fetch }): Promise<Map<string, PrimaryRead>> {
  const out = new Map<string, PrimaryRead>();
  const ua = deps.env.SEC_USER_AGENT?.trim();
  if (!ua) return out;
  const open = filingsToOpen(items, deps.now);
  // Once an hour, what the reader is seeing, so a quiet morning can be told from a reader that is not working.
  if (await store.tryLock("primary:heartbeat", 60).catch(() => false)) {
    const live = items.filter((n) => n.source === "SEC 8-K");
    const recent = live.filter((n) => Date.parse(n.ts) >= deps.now.getTime() - PRIMARY.freshMinutes * 60000);
    const today = (await store.cacheGet<{ n: number }>(`primary:count:${toEt(deps.now).date}`).catch(() => null))?.data?.n ?? 0;
    console.log(`primary filings: ${live.length} live 8-Ks in the news list, ${recent.length} from the last ${PRIMARY.freshMinutes / 60} hours, ${open.length} with an item that can be news by itself (${open.slice(0, 6).map((n) => `${n.symbols[0]} ${itemsOf(n).join("/")}`).join(", ") || "none"}); ${today} handed to the desk today`);
  }
  if (!open.length) return out;
  const day = toEt(deps.now).date, countKey = `primary:count:${day}`;
  let used = (await store.cacheGet<{ n: number }>(countKey).catch(() => null))?.data?.n ?? 0;
  if (used >= PRIMARY.perDay) return out;
  const snaps = (deps.data?.getSnapshots ? await deps.data.getSnapshots([...new Set(open.map((n) => n.symbols[0]))]).catch(() => ({})) : {}) as Record<string, { price: number }>;
  for (const n of open) {
    if (out.size >= PRIMARY.perRun || used >= PRIMARY.perDay) break;
    const sym = n.symbols[0];
    if (out.has(sym)) continue;
    // Each filing is looked at once, whatever it turns out to say.
    if (!(await store.tryLock(`primary:${n.id}`, 4 * 24 * 60).catch(() => false))) continue;
    // A warrant, unit or right, a stock under $5, or one with no price: passed over, and marked so it is not looked at again.
    const price = snaps[sym]?.price ?? 0;
    if (!/^[A-Z]{1,5}$/.test(sym) || price < PRIMARY.minPrice) {
      console.log(`primary filing ${sym} (items ${itemsOf(n).join(", ")}): passed over, ${!/^[A-Z]{1,5}$/.test(sym) ? "not a company's common stock" : price ? `the stock is $${price}, under $${PRIMARY.minPrice}` : "no price for the stock"}`);
      continue;
    }
    const text = await filingText(n.url, ua, deps.fetchImpl).catch(() => null);
    if (!text) continue;
    const why = materialReason(itemsOf(n), text);
    // One line per filing opened, so a coding session can see what the desk was handed and what was passed over.
    console.log(`primary filing ${sym} (items ${itemsOf(n).join(", ")}): ${why ? `handed to the story desk: ${why}` : "routine, passed over"}`);
    if (!why) continue;
    out.set(sym, { what: `8-K filed ${new Date(n.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET: ${why}`, url: n.url, text });
    await store.cachePut(countKey, { n: ++used }).catch(() => undefined);
  }
  return out;
}

/** A wire press release's own text (GlobeNewswire, PR Newswire), for a story taken early on it. Best effort. */
export async function releaseText(url: string, fetchImpl?: typeof fetch, max = PRIMARY.docChars): Promise<string | null> {
  if (!/^https:\/\/(www\.)?(globenewswire\.com|prnewswire\.com)\//.test(url)) return null;
  const html = await getText(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "text/html" }, fetchImpl, cacheMs: 3600_000, timeoutMs: 10_000, retries: 0 }).catch(() => "");
  const text = htmlText(html).replace(/\s+/g, " ").trim();
  return text.length > 400 ? text.slice(0, max) : null;
}

/**
 * The five-minute filing check. The story desk's full scan runs every 45 minutes (it costs an AI call each time), so
 * a filing read only then could wait most of an hour. This looks at the SEC's live list every five minutes, which
 * costs nothing; only when a material 8-K is there that has not been read does it call the desk, for that filing alone.
 */
export async function filingCheck(deps: { data: MarketData | null; env: NodeJS.ProcessEnv; now: Date; fetchImpl?: typeof fetch }, runDesk: () => Promise<{ detected: unknown[]; researched: Array<{ term: string; outcome: string }>; error: string | null }>): Promise<string> {
  if (!deps.env.SEC_USER_AGENT?.trim()) return "filing check: SEC_USER_AGENT is not set";
  const { fastNews } = await import("../sources/wires");
  const items = await fastNews(deps.env, deps.fetchImpl, deps.now);
  const open = filingsToOpen(items, deps.now);
  const unread: NewsItem[] = [];
  for (const n of open) if (!(await store.cacheGet(`primary:${n.id}`).catch(() => null))) unread.push(n);
  const live = items.filter((n) => n.source === "SEC 8-K").length;
  if (!unread.length) return `filing check: nothing new (${live} live 8-Ks, ${open.length} with an item that can be news by itself in the last ${PRIMARY.freshMinutes / 60} hours, all read)`;
  const r = await runDesk();
  return `filing check: ${unread.length} unread (${unread.slice(0, 6).map((n) => `${n.symbols[0]} ${itemsOf(n).join("/")}`).join(", ")}); ${r.detected.length} handed to the desk, ${r.researched.length} researched${r.researched.length ? ` (${r.researched.map((x) => `${x.term.slice(0, 50)}: ${x.outcome}`).join("; ")})` : ""}${r.error ? ` · ${r.error}` : ""}`;
}
