/**
 * regulations.gov (API v4): federal dockets, including FDA citizen petitions ("FDA-2025-P-…"), the agency's
 * acknowledgment, interim ("still reviewing") and final response letters, and public comments.
 * Under 21 CFR 10.30(e)(2) the FDA must answer a petition within 180 days, but an interim reply saying it has not
 * decided is allowed and common, so a petition can stay open for years.
 *
 * Key: an api.data.gov key (REGULATIONS_GOV_API_KEY, else FEC_API_KEY, which is the same kind of key); the shared
 * DEMO_KEY allows only a few requests an hour.
 */
import { mentionsCompany, mentionsDrug } from "../scout/company-match";
import { getText } from "../http";
import type { Lookup, RecordRow } from "./world-records";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/json" };
const API = "https://api.regulations.gov/v4";

export const regsKey = (env: NodeJS.ProcessEnv) => env.REGULATIONS_GOV_API_KEY?.trim() || env.FEC_API_KEY?.trim() || "DEMO_KEY";

/** Short sellers known to file FDA citizen petitions (and the law firm Scorpion has filed through). */
export const SHORT_SELLER_PETITIONERS = ["Scorpion Capital", "Pugsley Wood", "Hindenburg Research", "Muddy Waters", "Kerrisdale", "Spruce Point", "Culper Research", "Fuzzy Panda", "Blue Orca", "Grizzly Research", "Iceberg Research", "Viceroy Research", "Citron Research", "Wolfpack Research", "Bleecker Street", "Morpheus Research"];

interface RegDoc { id: string; attributes: { title?: string; docketId?: string; documentType?: string; agencyId?: string; postedDate?: string } }

async function regs<T>(path: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, cacheMs = 6 * 3600_000): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  // The key goes in the query (api.data.gov's way); errors from getText name only the host.
  return JSON.parse(await getText(`${API}${path}${sep}api_key=${encodeURIComponent(regsKey(env))}`, { headers: UA, cacheMs, timeoutMs: 20_000, retries: 1, minIntervalMs: 400, fetchImpl })) as T;
}

/** Pure: documents as rows (with the docket, type and agency). */
export const docRows = (data: RegDoc[]): RecordRow[] => data.map((d) => ({
  date: (d.attributes.postedDate ?? "").slice(0, 10), title: d.attributes.title ?? d.id,
  detail: [d.attributes.docketId, d.attributes.documentType, d.attributes.agencyId].filter(Boolean).join(" · "), url: `https://www.regulations.gov/document/${d.id}`,
}));

/** Documents mentioning a term (a drug, a company, a docket number), newest first. */
export async function searchRegs(term: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, agency?: string): Promise<Lookup> {
  const query = `regulations.gov "${term}"${agency ? ` (${agency})` : ""}`;
  try {
    const p = new URLSearchParams({ "filter[searchTerm]": /^[A-Z]{2,6}-\d{4}-[A-Z]-\d+/.test(term) ? term : `"${term}"`, sort: "-postedDate", "page[size]": "20" });
    if (agency) p.set("filter[agencyId]", agency);
    const j = await regs<{ data?: RegDoc[] }>(`/documents?${p}`, env, fetchImpl);
    return { query, rows: docRows(j.data ?? []) };
  } catch (e) {
    return { query, rows: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}

/** A docket's title (for a petition: what it asks the FDA to do). */
export async function docketTitle(docketId: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<string | null> {
  const j = await regs<{ data?: { attributes?: { title?: string } } }>(`/dockets/${encodeURIComponent(docketId)}`, env, fetchImpl, 7 * 86400_000).catch(() => null);
  return j?.data?.attributes?.title?.replace(/\s+/g, " ").trim() ?? null;
}

export interface Petition {
  docketId: string; petitioner: string; filed: string; request: string | null; url: string;
  status: "final response" | "interim response" | "no response yet"; statusDate: string | null; daysOpen: number; past180: boolean;
  symbols: string[]; shortSeller: boolean;
}

/** Pure: a petition's state from its docket's documents (petition, acknowledgment, interim and final response letters). */
export function petitionFrom(docketId: string, docs: Array<{ title: string; date: string }>, request: string | null, today: string): Petition | null {
  const sorted = docs.slice().sort((a, b) => a.date.localeCompare(b.date));
  const pet = sorted.find((d) => /^citizen petition\b/i.test(d.title)) ?? sorted.find((d) => /petition/i.test(d.title));
  if (!pet) return null;
  const petitioner = pet.title.replace(/^citizen petition\s+(from|by)\s+/i, "").replace(/\s*\(on behalf of\s+/i, " for ").replace(/\)\s*$/, "").trim();
  const final = sorted.filter((d) => /final response|petition (denial|approval|response) letter|letter .*(denying|granting)/i.test(d.title)).pop();
  const interim = sorted.filter((d) => /interim response/i.test(d.title)).pop();
  const daysOpen = Math.round((Date.parse(today) - Date.parse(pet.date)) / 86400_000);
  return {
    docketId, petitioner, filed: pet.date, request, url: `https://www.regulations.gov/docket/${docketId}`,
    status: final ? "final response" : interim ? "interim response" : "no response yet", statusDate: (final ?? interim)?.date ?? null,
    daysOpen, past180: !final && daysOpen > 180, symbols: [], shortSeller: SHORT_SELLER_PETITIONERS.some((n) => new RegExp(n.split(" ")[0], "i").test(petitioner)),
  };
}

/** Every FDA petition docket a name appears in (e.g. a short seller), with its state. */
export async function petitionsBy(name: string, env: NodeJS.ProcessEnv, today: string, fetchImpl?: typeof fetch): Promise<Petition[]> {
  const p = new URLSearchParams({ "filter[searchTerm]": `"${name}"`, "filter[agencyId]": "FDA", sort: "-postedDate", "page[size]": "50" });
  const j = await regs<{ data?: RegDoc[] }>(`/documents?${p}`, env, fetchImpl, 24 * 3600_000);
  const byDocket = new Map<string, Array<{ title: string; date: string }>>();
  for (const d of j.data ?? []) {
    const id = d.attributes.docketId;
    if (!id || !/-P-/.test(id)) continue;
    byDocket.set(id, [...(byDocket.get(id) ?? []), { title: d.attributes.title ?? "", date: (d.attributes.postedDate ?? "").slice(0, 10) }]);
  }
  const out: Petition[] = [];
  for (const [id, docs] of byDocket) {
    // The docket's own documents (a response may not carry the petitioner's name).
    const all = await regs<{ data?: RegDoc[] }>(`/documents?${new URLSearchParams({ "filter[docketId]": id, "page[size]": "50" })}`, env, fetchImpl, 24 * 3600_000).then((r) => (r.data ?? []).map((d) => ({ title: d.attributes.title ?? "", date: (d.attributes.postedDate ?? "").slice(0, 10) }))).catch(() => docs);
    const pet = petitionFrom(id, all.length ? all : docs, await docketTitle(id, env, fetchImpl), today);
    if (pet) out.push(pet);
  }
  return out.sort((a, b) => b.filed.localeCompare(a.filed));
}

/** FDA citizen petitions posted since a date (newest first), with what each asks for. */
export async function recentPetitions(env: NodeJS.ProcessEnv, since: string, today: string, fetchImpl?: typeof fetch, max = 40): Promise<Petition[]> {
  const p = new URLSearchParams({ "filter[searchTerm]": "\"Citizen Petition\"", "filter[agencyId]": "FDA", "filter[postedDate][ge]": since, sort: "-postedDate", "page[size]": "100" });
  const j = await regs<{ data?: RegDoc[] }>(`/documents?${p}`, env, fetchImpl, 3 * 3600_000);
  const out: Petition[] = [];
  for (const d of (j.data ?? []).filter((x) => /^citizen petition\b/i.test(x.attributes.title ?? "") && x.attributes.docketId).slice(0, max)) {
    const pet = petitionFrom(d.attributes.docketId!, [{ title: d.attributes.title!, date: (d.attributes.postedDate ?? "").slice(0, 10) }], await docketTitle(d.attributes.docketId!, env, fetchImpl), today);
    if (pet) out.push(pet);
  }
  return out;
}

/**
 * Pure: the stocks a petition is about: it has to name the company or one of its drugs (see company-match.ts; one
 * word shared with the company's name is not a match).
 */
export function matchSymbols(p: Pick<Petition, "request" | "petitioner">, names: Array<{ symbol: string; company?: string | null; drugs?: string[] }>): string[] {
  const text = `${p.request ?? ""} ${p.petitioner}`;
  return [...new Set(names.filter((n) => (n.company && mentionsCompany(text, n.company)) || (n.drugs ?? []).some((d) => mentionsDrug(text, d))).map((n) => n.symbol))];
}
