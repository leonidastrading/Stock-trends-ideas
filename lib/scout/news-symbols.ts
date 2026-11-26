/**
 * The news feed's ticker tags, checked before any page uses them. The feed tags UK, Canadian and Asian company
 * notices with the US symbol that has the same letters (Babcock International, LSE: BAB, arrived as the US bond
 * fund BAB and was priced as it). A tag on an item that reads like a foreign listing stays only when the text names
 * the US company behind the symbol or gives it with a US exchange; otherwise it comes off and the item says where
 * the company is listed. Company names are the SEC's own list, kept in memory for a day.
 */
import type { NewsItem } from "../alpaca";
import { cleanNewsSymbols, looksForeign, qualifiedSymbols } from "./company-match";

let memo: { at: number; names: Map<string, string> } | null = null;

async function usNames(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Map<string, string>> {
  if (memo && Date.now() - memo.at < 24 * 3600_000 && !fetchImpl) return memo.names;
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) return new Map();
  const { secTickerList } = await import("../sources/edgar");
  const names = new Map((await secTickerList(ua, fetchImpl)).map((x) => [x.ticker, x.title]));
  if (!fetchImpl && names.size) memo = { at: Date.now(), names };
  return names;
}

/** Pure: the same items with foreign listings taken off their US tags (see cleanNewsSymbols). `names` empty: only tags the text itself gives a foreign exchange for come off. */
export function cleanNewsItems<T extends Pick<NewsItem, "headline" | "summary" | "symbols">>(items: T[], names: Map<string, string>): T[] {
  return items.map((n) => {
    if (!n.symbols.length) return n;
    const text = `${n.headline} ${n.summary ?? ""}`;
    const explicit = qualifiedSymbols(text).foreign.length > 0;
    if (!explicit && (!names.size || !looksForeign(text))) return n;
    const r = cleanNewsSymbols(n, (s) => names.get(s) ?? null);
    // Without the SEC's names, only a symbol the text gives a foreign exchange for is taken off.
    const off = names.size ? r.foreign : r.foreign.filter((f) => f.includes(":"));
    if (!off.length) return n;
    const kept = n.symbols.filter((s) => !off.some((f) => f === s || f.endsWith(`: ${s}`)));
    return { ...n, symbols: kept, summary: `${n.summary ?? ""}${n.summary ? " " : ""}[Listed outside the US (${off.join(", ")}); not the US symbol with the same letters.]` };
  });
}

/** The feed's items with their tags checked. Never throws: on any failure the items come back as they were. */
export async function cleanNews<T extends Pick<NewsItem, "headline" | "summary" | "symbols">>(items: T[], env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<T[]> {
  try {
    if (!items.some((n) => n.symbols.length && (looksForeign(`${n.headline} ${n.summary ?? ""}`) || qualifiedSymbols(`${n.headline} ${n.summary ?? ""}`).foreign.length))) return items;
    return cleanNewsItems(items, await usNames(env, fetchImpl).catch(() => new Map<string, string>()));
  } catch { return items; }
}
