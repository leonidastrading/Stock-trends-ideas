/**
 * Upcoming biopharma catalysts, from two public sources:
 * - FDA decision dates (PDUFA, advisory committees, label expansions) from RTTNews' FDA calendar
 *   (rttnews.com/corpinfo/fdacalendar.aspx, ten rows a page, furthest-out dates first). Dates are exact
 *   ("02/28/2027") or loose ("Feb 2027", "Q4 2026", "1H 2027").
 * - Phase 3 trials run by companies whose primary completion falls in the next six months, from the
 *   ClinicalTrials.gov API, matched to US-listed tickers through the SEC's company list. Primary completion
 *   is when the last patient's main measurement is taken; results are usually announced weeks to months later.
 * Pure parsers here; fetching is light (about 8 calendar pages and one API call a day).
 */
import { getText } from "../http";

export interface FdaEvent { company: string; symbol: string | null; otherSymbols: string[]; drug: string; when: string; date: string | null; month: string | null; event: string; outcome: string; status: string; note: string; detailUrl: string | null }
export interface TrialReadout { nct: string; title: string; sponsor: string; symbol: string; completion: string; conditions: string[]; drugs: string[]; phase: string }

const UA = { "user-agent": "Mozilla/5.0 (compatible; trend-scout research)" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const text = (s: string) => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|’/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Pure: an RTTNews date ("02/28/2027", "Feb 2027", "Q4 2026", "1H 2027") as an exact date and/or the month it falls in or ends by. */
export function parseWhen(raw: string): { date: string | null; month: string | null } {
  const s = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) { const d = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; return { date: d, month: d.slice(0, 7) }; }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return { date: null, month: `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}` };
  m = /^Q([1-4])\s+(\d{4})$/i.exec(s);
  if (m) return { date: null, month: `${m[2]}-${String(Number(m[1]) * 3).padStart(2, "0")}` };
  m = /^([12])H\s+(\d{4})$/i.exec(s);
  if (m) return { date: null, month: `${m[2]}-${m[1] === "1" ? "06" : "12"}` };
  m = /(\d{4})/.exec(s);
  return { date: null, month: m ? `${m[1]}-12` : null };
}

/** Pure: the rows of one RTTNews FDA calendar page. */
export function parseFdaCalendar(html: string): FdaEvent[] {
  const out: FdaEvent[] = [];
  for (const row of html.split(/class="grid-row border-bottom[^"]*"/).slice(1)) {
    const cell = (n: number) => new RegExp(`class="tblcontent${n}"[^>]*>([\\s\\S]*?)</div>`).exec(row)?.[1] ?? "";
    const c1 = cell(1), c3 = cell(3);
    const company = text(c1.split(/<br/i)[0]);
    const symbol = />([A-Z][A-Z0-9.]{0,6})<\/a>/.exec(c1)?.[1] ?? null;
    const others = (/\(([\s\S]*?)\)/.exec(text(c1))?.[1] ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== symbol);
    const when = text(/class="bg-purple">([^<]*)</.exec(c3)?.[1] ?? "");
    const event = text(c3.replace(/<span class="bg-purple">[^<]*<\/span>/, ""));
    if (!company || !event) continue;
    out.push({
      company, symbol, otherSymbols: others, drug: text(cell(2)), when, ...parseWhen(when), event,
      outcome: text(/lblOutcome">([^<]*)</.exec(row)?.[1] ?? "") || "Pending",
      // The status field is a short label ("Priority Review") or, on some rows, the review history: keep that as a note.
      ...(() => { const s = text(/hdnDrugStatus"[^>]*value="([^"]*)"/.exec(row)?.[1] ?? ""); return s.length <= 40 ? { status: s, note: "" } : { status: "", note: s }; })(),
      detailUrl: (() => { const id = /FDADetail\.aspx\?ID=(\d+)/.exec(row)?.[1]; return id ? `https://www.rttnews.com/corpinfo/FDADetail.aspx?ID=${id}` : null; })(),
    });
  }
  return out;
}

/** Upcoming FDA events: pages from the furthest-out until they reach dates a week before today. */
export async function fetchFdaCalendar(today: string, fetchImpl?: typeof fetch, maxPages = 12): Promise<FdaEvent[]> {
  const all: FdaEvent[] = [];
  const weekAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86400_000).toISOString().slice(0, 10);
  for (let p = 1; p <= maxPages; p++) {
    const html = await getText(`https://www.rttnews.com/corpinfo/fdacalendar.aspx?PageNum=${p}`, { headers: UA, cacheMs: 6 * 60 * 60000, minIntervalMs: 800, fetchImpl, retries: 1 });
    const rows = parseFdaCalendar(html);
    if (!rows.length) break;
    all.push(...rows);
    // Pages run from the latest dates back: stop once a whole page is in the past.
    if (rows.every((r) => (r.date ?? `${r.month ?? "9999-12"}-28`) < weekAgo)) break;
  }
  const seen = new Set<string>();
  return all.filter((r) => { const k = `${r.company}|${r.drug}|${r.when}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ------------------------------------------------------------- trials

const GENERIC = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|sa|ag|nv|se|ab|asa|as|gmbh|holdings?|group|the|international)\b/g;
const SECTOR = /\b(pharmaceuticals?|pharma|therapeutics|biotherapeutics|biosciences?|bio|biopharma(ceuticals)?|biotech(nology)?|biologics|medical|sciences?|labs?|laboratories)\b/g;
/** Pure: a company name reduced to compare sponsors with SEC registrants. */
export const normName = (s: string, core = false) => {
  let x = s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(GENERIC, " ");
  if (core) x = x.replace(SECTOR, " ");
  return x.replace(/\s+/g, " ").trim();
};

/** Pure: a lookup from sponsor name to US ticker: exact match first, then on the name without words like "Therapeutics". */
export function sponsorMatcher(companies: Array<{ ticker: string; title: string }>): (sponsor: string) => string | null {
  const exact = new Map<string, string>(), core = new Map<string, string | null>();
  for (const c of companies) {
    if (!/^[A-Z]{1,5}$/.test(c.ticker)) continue; // common shares only (no warrants, units, preferreds)
    const e = normName(c.title);
    if (e && !exact.has(e)) exact.set(e, c.ticker);
    const k = normName(c.title, true);
    if (k.length >= 4) core.set(k, core.has(k) && core.get(k) !== c.ticker ? null : c.ticker); // ambiguous core names never match
  }
  return (sponsor) => exact.get(normName(sponsor)) ?? (() => { const k = normName(sponsor, true); return k.length >= 4 ? core.get(k) ?? null : null; })();
}

interface CtStudy { protocolSection?: { identificationModule?: { nctId?: string; briefTitle?: string }; statusModule?: { primaryCompletionDateStruct?: { date?: string } }; sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } }; conditionsModule?: { conditions?: string[] }; designModule?: { phases?: string[] }; armsInterventionsModule?: { interventions?: Array<{ name?: string }> } } }

/** Pure: studies as readouts on US-listed sponsors (others dropped). */
export function trialReadouts(studies: CtStudy[], match: (sponsor: string) => string | null): TrialReadout[] {
  const out: TrialReadout[] = [];
  for (const s of studies) {
    const p = s.protocolSection;
    const sponsor = p?.sponsorCollaboratorsModule?.leadSponsor?.name ?? "";
    const symbol = sponsor ? match(sponsor) : null;
    const nct = p?.identificationModule?.nctId;
    const completion = p?.statusModule?.primaryCompletionDateStruct?.date;
    if (!symbol || !nct || !completion) continue;
    const drugs = (p?.armsInterventionsModule?.interventions ?? []).map((i) => i.name ?? "").filter((n) => n && !/placebo|vehicle|standard of care|run-in/i.test(n));
    out.push({ nct, title: p?.identificationModule?.briefTitle ?? "", sponsor, symbol, completion, conditions: p?.conditionsModule?.conditions ?? [], drugs: [...new Set(drugs)].slice(0, 3), phase: (p?.designModule?.phases ?? []).join("/").replace(/PHASE/g, "Phase ") });
  }
  return out.sort((a, b) => a.completion.localeCompare(b.completion));
}

/** Phase 3 company trials with primary completion from today to six months out. */
export async function fetchTrialReadouts(today: string, companies: Array<{ ticker: string; title: string }>, fetchImpl?: typeof fetch): Promise<TrialReadout[]> {
  const end = new Date(Date.parse(`${today}T12:00:00Z`) + 183 * 86400_000).toISOString().slice(0, 10);
  const fields = "NCTId,BriefTitle,LeadSponsorName,PrimaryCompletionDate,Condition,InterventionName,Phase";
  const q = `AREA[Phase]PHASE3 AND AREA[LeadSponsorClass]INDUSTRY AND AREA[PrimaryCompletionDate]RANGE[${today},${end}]`;
  const studies: CtStudy[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(q)}&filter.overallStatus=ACTIVE_NOT_RECRUITING,RECRUITING,ENROLLING_BY_INVITATION,COMPLETED&pageSize=1000&fields=${fields}${token ? `&pageToken=${token}` : ""}`;
    const j = JSON.parse(await getText(url, { headers: UA, cacheMs: 12 * 60 * 60000, fetchImpl, retries: 1 })) as { studies?: CtStudy[]; nextPageToken?: string };
    studies.push(...(j.studies ?? []));
    token = j.nextPageToken;
    if (!token) break;
  }
  return trialReadouts(studies, sponsorMatcher(companies));
}
