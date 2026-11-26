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

/** The companies and drugs the scout knows: stocks on cards (by their listed name) and the Pharma tab's FDA calendar. */
async function knownNames(): Promise<Array<{ symbol: string; company?: string | null; drugs?: string[] }>> {
  const briefs = await store.cardBriefsSince(180).catch(() => []);
  const syms = [...new Set(briefs.flatMap((b) => [b.primaryTicker, ...b.tickers]))];
  const info = await store.symbolInfo(syms).catch(() => new Map());
  const out: Array<{ symbol: string; company?: string | null; drugs?: string[] }> = [];
  for (const s of syms) { const n = (info.get(s) as { name?: string | null } | undefined)?.name; if (n) out.push({ symbol: s, company: n }); }
  const fda = await store.cacheGet<import("../sources/pharma").FdaEvent[]>("pharma:fda").catch(() => null);
  for (const e of fda?.data ?? []) if (e.symbol) out.push({ symbol: e.symbol, company: e.company, drugs: e.drug ? [e.drug] : [] });
  return out;
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
  // The short sellers' list is refreshed weekly; its links are matched again on every run (the matcher can change).
  let shortSellers = withSyms(prev?.shortSellers ?? []);
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
  const corrected = await correctLinks(prev, watch).catch(() => "");
  const pushed = await alerts(prev, watch, env, fetchImpl).catch(() => 0);
  return `petitions: ${recent.length} FDA citizen petitions in 30 days (${recent.filter((p) => p.symbols.length).length} on known stocks), ${shortSellers.length} by short sellers${pushed ? `, ${pushed} alerts` : ""}${corrected}${error ? ` · ${error}` : ""}`;
}

/**
 * Links the last run had and this one does not (a petition matched to a stock on one shared word) are wrong links
 * taken off. A card on such a stock that speaks of a petition keeps its text and gets a correction note.
 */
async function correctLinks(prev: PetitionWatch | null, now: PetitionWatch): Promise<string> {
  if (!prev) return "";
  const kept = new Map([...now.recent, ...now.shortSellers].map((p) => [p.docketId, new Set(p.symbols)]));
  const removed: Array<{ docket: string; symbol: string }> = [];
  for (const p of [...prev.recent, ...prev.shortSellers]) for (const s of p.symbols ?? []) if (kept.has(p.docketId) && !kept.get(p.docketId)!.has(s) && !removed.some((r) => r.docket === p.docketId && r.symbol === s)) removed.push({ docket: p.docketId, symbol: s });
  if (!removed.length) return "";
  const cards = await store.cardsSince(120).catch(() => []);
  let notes = 0;
  for (const r of removed) {
    for (const c of cards.filter((x) => x.primaryTicker === r.symbol && /citizen petition|petition/i.test(JSON.stringify(x.card)))) {
      if (!(await store.tryLock(`petition-correction:${c.id}:${r.docket}`, 60 * 24 * 3650).catch(() => false))) continue;
      await store.addTrackEvent(c.id, "correction", `FDA citizen petition ${r.docket} was linked to ${r.symbol} by mistake (one word of the company's name appeared in it). It does not concern ${r.symbol}; any use of it in this card is wrong. The card's text is kept as written.`).catch(() => undefined);
      notes++;
    }
  }
  console.log(`petitions: ${removed.length} wrong links removed (${removed.slice(0, 40).map((r) => `${r.docket}→${r.symbol}`).join(", ")}); ${notes} correction notes on cards`);
  return `, ${removed.length} wrong links removed, ${notes} correction notes`;
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
