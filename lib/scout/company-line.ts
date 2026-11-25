/**
 * One line on what a company does, for the top of a card: the opening of its own Wikipedia article and the industry
 * the SEC files it under. Looked up once per stock and kept (no AI, nothing guessed: when neither source is sure of
 * the company, the line is left out).
 */
import { getJson } from "../http";
import { secTickerList } from "../sources/edgar";
import { companyArticle } from "../sources/wikipedia";
import * as store from "./store";

export interface CompanyAbout { symbol: string; at: string; about: string | null; article: string | null; industry: string | null }
const UA = { "user-agent": "trend-scout/0.1 (research dashboard)" };
export const COMPANY_LINE = { keepDays: 45, retryDays: 3, maxChars: 230 };

/** Pure: the opening sentence or two of an article, whole sentences only, without the pronunciation and listing asides. */
export function firstSentences(extract: string, max = COMPANY_LINE.maxChars): string | null {
  const text = extract.replace(/\s*\([^()]*(?:\/|pronounced|NYSE|Nasdaq|NASDAQ|stylized|formerly|listen)[^()]*\)/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 25) return null;
  let out = "", n = 0;
  // "Inc." and "Corp." end with a full stop but not the sentence. At most two sentences: what it is, then one more detail.
  for (const s of text.split(/(?<=(?<!\b(?:Inc|Corp|Co|Ltd|L\.P|U\.S|St|Dr|No))[.!?])\s+(?=[A-Z])/)) {
    if (out && out.length + s.length + 1 > max) break;
    out = out ? `${out} ${s}` : s;
    if (++n >= 2 || out.length >= max * 0.5) break;
  }
  return out.length > max ? `${out.slice(0, max).replace(/\s+\S*$/, "")}…` : out;
}

/** Pure: the SEC's industry label in ordinary case ("PRINTED CIRCUIT BOARDS" → "Printed circuit boards"). */
export const industryLabel = (sic: string | null | undefined): string | null => {
  const s = (sic ?? "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/\b(nec|u\.s\.|usa)\b/g, (m) => m.toUpperCase()) : null;
};

export async function companyAbout(symbol: string): Promise<CompanyAbout | null> {
  return (await store.cacheGet<CompanyAbout>(`company-line:${symbol}`).catch(() => null))?.data ?? null;
}

/** Whether the line on file is missing or old enough to look up again. */
export function isStale(a: CompanyAbout | null, now: Date): boolean {
  if (!a) return true;
  const age = (now.getTime() - Date.parse(a.at)) / 86400_000;
  return age > (a.about || a.industry ? COMPANY_LINE.keepDays : COMPANY_LINE.retryDays);
}

const inFlight = new Map<string, Promise<CompanyAbout>>();

/** Look the company up (the SEC's record, then Wikipedia) and keep the result. One lookup per stock at a time. */
export function fillCompanyAbout(symbol: string, env: NodeJS.ProcessEnv = process.env, now = new Date(), fetchImpl?: typeof fetch): Promise<CompanyAbout> {
  const running = inFlight.get(symbol);
  if (running) return running;
  const work = (async () => {
    const out: CompanyAbout = { symbol, at: now.toISOString(), about: null, article: null, industry: null };
    let name = (await store.symbolInfo([symbol]).catch(() => new Map<string, store.SymbolInfo>())).get(symbol)?.name ?? null;
    const ua = env.SEC_USER_AGENT?.trim();
    if (ua) {
      try {
        const hit = (await secTickerList(ua, fetchImpl)).find((t) => t.ticker === symbol);
        if (hit) {
          name ??= hit.title;
          const sub = await getJson<{ sicDescription?: string }>(`https://data.sec.gov/submissions/CIK${hit.cik.padStart(10, "0")}.json`, { headers: { "user-agent": ua }, minIntervalMs: 150, cacheMs: 3 * 3600_000, fetchImpl, retries: 1 });
          out.industry = industryLabel(sub.sicDescription);
        }
      } catch { /* the line can do without the SEC's label */ }
    }
    try {
      const article = name && !/not a listed symbol/i.test(name) ? await companyArticle(name, fetchImpl) : null;
      if (article) {
        const j = await getJson<{ extract?: string }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article.replace(/ /g, "_"))}`, { headers: UA, fetchImpl, retries: 1, timeoutMs: 10_000 });
        out.about = firstSentences(j.extract ?? "");
        out.article = out.about ? article : null;
      }
    } catch { /* no article line */ }
    await store.cachePut(`company-line:${symbol}`, out).catch(() => undefined);
    return out;
  })().finally(() => inFlight.delete(symbol));
  inFlight.set(symbol, work);
  return work;
}
