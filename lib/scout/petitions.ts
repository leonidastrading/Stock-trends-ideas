/**
 * FDA citizen-petition watch (regulations.gov):
 * - every FDA citizen petition posted in the last 30 days, with what it asks for, matched to stocks by the company and
 *   drug names the scout knows (stocks on cards, the Pharma tab's FDA calendar);
 * - every petition filed by a short seller (Scorpion Capital and others), with its status: no response yet, an
 *   interim "still reviewing" reply, or a final response, and whether it is past the FDA's 180 days.
 * A new petition on a card stock or by a short seller, and a short seller's petition getting a response, are pushed.
 * Kept for the Pharma tab, research and the chat.
 */
import { toEt, addDays } from "../time";
import { matchSymbols, petitionsBy, recentPetitions, SHORT_SELLER_PETITIONERS, type Petition } from "../sources/regulations";
import * as store from "./store";

export interface PetitionWatch { at: string; recent: Petition[]; shortSellers: Petition[]; shortSellersAt: string | null; error: string | null }

const GENERIC = new Set(["inc", "corp", "corporation", "company", "holdings", "group", "therapeutics", "pharmaceuticals", "pharma", "biosciences", "bio", "medical", "health", "the", "class", "common", "stock", "ordinary", "shares", "limited", "ltd", "plc", "international", "technologies", "systems"]);

/** Pure: the words a company or drug is known by ("TransMedics Group Inc" → "TransMedics"). */
export function nameWords(name: string): string[] {
  return name.replace(/\([^)]*\)/g, " ").split(/[\s,./]+/).map((w) => w.replace(/[^\w-]/g, "")).filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase())).slice(0, 2);
}

async function knownNames(): Promise<Array<{ symbol: string; words: string[] }>> {
  const briefs = await store.cardBriefsSince(180).catch(() => []);
  const syms = [...new Set(briefs.flatMap((b) => [b.primaryTicker, ...b.tickers]))];
  const info = await store.symbolInfo(syms).catch(() => new Map());
  const out: Array<{ symbol: string; words: string[] }> = [];
  for (const s of syms) { const n = (info.get(s) as { name?: string | null } | undefined)?.name; if (n) out.push({ symbol: s, words: nameWords(n) }); }
  const fda = await store.cacheGet<import("../sources/pharma").FdaEvent[]>("pharma:fda").catch(() => null);
  for (const e of fda?.data ?? []) if (e.symbol) out.push({ symbol: e.symbol, words: [...nameWords(e.company), ...e.drug.split(/[\s,/()]+/).filter((w) => w.length >= 5 && /^[A-Za-z][a-z-]+$/.test(w)).slice(0, 2)] });
  return out.filter((n) => n.words.length);
}

/** One run: recent petitions (daily), short sellers' petitions (weekly). Returns a log line. */
export async function runPetitionWatch(env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl?: typeof fetch): Promise<string> {
  const today = toEt(now).date;
  const prev = (await store.cacheGet<PetitionWatch>("regs:petitions").catch(() => null))?.data ?? null;
  const names = await knownNames();
  const withSyms = (ps: Petition[]) => ps.map((p) => ({ ...p, symbols: matchSymbols(p, names) }));
  let error: string | null = null;
  let recent = prev?.recent ?? [];
  try {
    recent = withSyms(await recentPetitions(env, addDays(today, -30), today, fetchImpl));
  } catch (e) {
    error = `recent petitions: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
  }
  let shortSellers = prev?.shortSellers ?? [];
  let shortSellersAt = prev?.shortSellersAt ?? null;
  if (!shortSellersAt || Date.now() - Date.parse(shortSellersAt) > 7 * 86400_000) {
    try {
      const all = new Map<string, Petition>();
      for (const n of SHORT_SELLER_PETITIONERS) for (const p of await petitionsBy(n, env, today, fetchImpl)) all.set(p.docketId, p);
      shortSellers = withSyms([...all.values()].map((p) => ({ ...p, shortSeller: true })));
      shortSellersAt = now.toISOString();
    } catch (e) {
      error = [error, `short sellers' petitions: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`].filter(Boolean).join("; ");
    }
  }
  const watch: PetitionWatch = { at: now.toISOString(), recent, shortSellers, shortSellersAt, error };
  await store.cachePut("regs:petitions", watch);
  const pushed = await alerts(prev, watch, env, fetchImpl).catch(() => 0);
  return `petitions: ${recent.length} FDA citizen petitions in 30 days (${recent.filter((p) => p.symbols.length).length} on known stocks), ${shortSellers.length} by short sellers${pushed ? `, ${pushed} alerts` : ""}${error ? ` · ${error}` : ""}`;
}

async function alerts(prev: PetitionWatch | null, now: PetitionWatch, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<number> {
  const { pushConfigured, sendPush } = await import("../notify");
  if (!pushConfigured(env) || !prev) return 0; // the first run only fills the list
  const seen = new Set([...prev.recent, ...prev.shortSellers].map((p) => p.docketId));
  const before = new Map(prev.shortSellers.map((p) => [p.docketId, p.status]));
  const base = env.DASHBOARD_URL?.replace(/\/$/, "");
  let n = 0;
  const send = async (key: string, title: string, message: string, url: string) => {
    if (!(await store.claimNotification(key, title))) return;
    await sendPush({ title, message: message.slice(0, 450), tags: ["scales"], priority: 3, click: base ? `${base}/pharma#petitions` : url }, env, fetchImpl);
    n++;
  };
  for (const p of [...now.recent, ...now.shortSellers]) {
    if (!seen.has(p.docketId) && (p.symbols.length || p.shortSeller)) await send(`petition:${p.docketId}`, `FDA citizen petition${p.symbols.length ? ` on ${p.symbols.join(", ")}` : ""} from ${p.petitioner}`.slice(0, 120), `${p.docketId}, filed ${p.filed}: ${p.request ?? "(request not read)"}`, p.url);
  }
  for (const p of now.shortSellers) {
    const was = before.get(p.docketId);
    if (was && was !== p.status) await send(`petition:${p.docketId}:${p.status}`, `FDA ${p.status} to ${p.petitioner}${p.symbols.length ? ` (${p.symbols.join(", ")})` : ""}`.slice(0, 120), `${p.docketId} (filed ${p.filed}): ${p.request ?? ""}`, p.url);
  }
  return n;
}

/** Pure: a petition in one line for research and the chat. */
export const petitionLine = (p: Petition) => `FDA citizen petition ${p.docketId} from ${p.petitioner}, filed ${p.filed}: ${(p.request ?? "request not read").slice(0, 220)} [${p.status}${p.statusDate ? ` ${p.statusDate}` : ""}${p.past180 ? `; open ${p.daysOpen} days, past the FDA's 180` : ""}] (${p.url})`;
