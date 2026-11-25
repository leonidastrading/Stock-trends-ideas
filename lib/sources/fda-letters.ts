/**
 * The FDA's own rejection letters ("complete response letters"), from openFDA: api.fda.gov/transparency/crl.json.
 * Free, no key. Since 2025 the FDA publishes the letter it sends when it declines to approve a drug, usually within
 * days to a few weeks; the set holds about 150 letters for drugs still unapproved, nearly all from 2024 on.
 *
 * Why it matters: a company's press release about a rejection is its own telling. The letter says what the FDA
 * actually faulted, under plain headings: CLINICAL (the evidence itself: usually a new trial), PRODUCT QUALITY and
 * FACILITY INSPECTIONS (how and where the drug is made: usually fixable in months), NONCLINICAL, CLINICAL
 * PHARMACOLOGY, HUMAN FACTORS. Of the letters on file, about two thirds fault the factory or the product's quality
 * and about one in five the clinical evidence. Pure code, no AI: the headings are read, not interpreted.
 */
import { getJson } from "../http";

export type Fault = "clinical evidence" | "dosing studies" | "animal or lab studies" | "product quality" | "factory inspection" | "device or usability";
/** What the faults mean for the way back: a new trial, studies short of a trial, a fix in manufacturing, or not readable. */
export type Verdict = "clinical" | "studies" | "fixable" | "unclear";

export interface FdaLetterRaw { letter_date?: string; approval_status?: string; company_name?: string; application_number?: string[]; letter_type?: string; text?: string; file_name?: string }
export interface FdaLetter {
  key: string;
  /** The letter's own date. */
  date: string;
  company: string; application: string;
  faults: Fault[]; verdict: Verdict;
  /** The FDA's first words under its first heading (or after "cannot approve" when the letter has no headings). */
  quote: string;
}

const FAULTS: Array<[Fault, RegExp]> = [
  ["factory inspection", /FACILIT/],
  ["product quality", /PRODUCT QUALITY|DRUG PRODUCT|DRUG SUBSTANCE|MICROBIOLOGY|CHEMISTRY|MANUFACTURING|\bCMC\b/],
  ["device or usability", /HUMAN FACTORS|DEVICE|SOFTWARE|PERFORMANCE TESTING|ELECTRICAL/],
  ["dosing studies", /CLINICAL PHARMACOLOGY|BIOPHARMACEUTICS|BIOEQUIVALENCE/],
  ["clinical evidence", /CLINICAL|STATISTIC|EFFICACY/],
];
/** The letter's standing sections after the deficiencies: every letter has them, so they say nothing. */
const BOILERPLATE = /\n\s*(?:PRESCRIBING INFORMATION|LABELING|CARTON AND CONTAINER|PROPRIETARY NAME|SAFETY UPDATE|OTHER|ADDITIONAL COMMENTS|NOTICE REGARDING)\b/;

/** Pure: the faults named by one heading line ("NONCLINICAL/PRODUCT QUALITY", "CLINICAL/STATISTICAL"). */
export function faultsOf(heading: string): Fault[] {
  let h = heading.toUpperCase();
  const out: Fault[] = [];
  // "NONCLINICAL" holds the word "CLINICAL": taken out first.
  if (/NON-?CLINICAL|TOXICOLOGY/.test(h)) { out.push("animal or lab studies"); h = h.replace(/NON-?CLINICAL/g, " "); }
  for (const [fault, re] of FAULTS) {
    if (!re.test(h)) continue;
    out.push(fault);
    if (fault === "dosing studies") h = h.replace(/CLINICAL PHARMACOLOGY/g, " ");
  }
  return out;
}

const mdy = (d: string) => /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim());

/** Pure: one letter as the scout shows it, or null when it has no date or company. */
export function readLetter(raw: FdaLetterRaw): FdaLetter | null {
  const m = mdy(raw.letter_date ?? "");
  const company = (raw.company_name ?? "").replace(/\s+/g, " ").trim();
  if (!m || !company) return null;
  const date = `${m[3]}-${m[1]}-${m[2]}`;
  const application = (raw.application_number ?? []).join(", ");
  const text = raw.text ?? "";
  const start = Math.max(0, text.search(/cannot approve (?:this|these|the) (?:application|supplement|BLA|NDA)/i));
  const body = text.slice(start);
  const end = body.search(BOILERPLATE);
  const part = end > 0 ? body.slice(0, end) : body.slice(0, 8000);
  const faults: Fault[] = [];
  let firstAt = -1, offset = 0;
  for (const line of part.split("\n")) {
    const h = line.trim().replace(/^\d+[.)]\s*/, "").replace(/[:.]$/, "");
    // A heading: a short line in capitals (the letterhead and the application number are not).
    if (h.length >= 5 && h.length <= 50 && h === h.toUpperCase() && /[A-Z]{4}/.test(h) && !/\d{3}|FOOD & DRUG|ADMINISTRATION|COMPLETE RESPONSE/.test(h)) {
      const found = faultsOf(h);
      if (found.length && firstAt < 0) firstAt = offset + line.length;
      for (const f of found) if (!faults.includes(f)) faults.push(f);
    }
    offset += line.length + 1;
  }
  // No headings (older letters, and the biologics centre's): the letter's own wording, clinical first.
  let worded = -1;
  if (!faults.length) {
    const clinical = part.search(/substantial evidence|adequate and well-controlled|(?:not|fail\w*|lack\w*|insufficient)[^.]{0,80}(?:effectiveness|efficacy)/i);
    const making = clinical >= 0 ? -1 : part.search(/facilit(?:y|ies)[^.]{0,120}(?:deficienc|inspection|observations)|inspection of[^.]{0,80}(?:facility|site)|product quality/i);
    if (clinical >= 0) { faults.push("clinical evidence"); worded = clinical; }
    else if (making >= 0) { faults.push(/product quality/i.test(part.slice(making, making + 20)) ? "product quality" : "factory inspection"); worded = making; }
  }
  const verdict: Verdict = faults.includes("clinical evidence") ? "clinical" : faults.some((f) => f === "dosing studies" || f === "animal or lab studies") ? "studies" : faults.length ? "fixable" : "unclear";
  // The quote: under the first heading; else the sentence the wording was found in; else what follows "cannot approve".
  const sentenceAt = (i: number) => part.slice(Math.max(0, part.lastIndexOf(". ", i) + 2, part.lastIndexOf("\n\n", i) + 2));
  const from = firstAt >= 0 ? part.slice(firstAt) : worded >= 0 ? sentenceAt(worded) : start > 0 ? body.replace(/^[^.]*\.\s*(?:We have described[^.]*\.)?/i, "") : "";
  const quote = from.replace(/\s+/g, " ").trim().slice(0, 360);
  return { key: `${application || company}|${date}`, date, company, application, faults, verdict, quote };
}

/** Pure: the verdict in plain words. */
export function verdictLabel(v: Verdict): string {
  return v === "clinical" ? "wants more clinical evidence (usually a new trial)" : v === "studies" ? "wants more studies, short of a new trial" : v === "fixable" ? "manufacturing or factory: usually fixable in months" : "reasons not in a form the scout can read";
}

/** Every letter on file for a drug still unapproved, newest first (two requests; the FDA updates the set about weekly). */
export async function fetchFdaLetters(fetchImpl?: typeof fetch): Promise<{ letters: FdaLetter[]; lastUpdated: string | null }> {
  const out: FdaLetter[] = [];
  let lastUpdated: string | null = null;
  for (let skip = 0; skip < 1000; skip += 100) {
    const j = await getJson<{ meta?: { last_updated?: string }; results?: FdaLetterRaw[] }>(`https://api.fda.gov/transparency/crl.json?search=approval_status:Unapproved&limit=100&skip=${skip}`, { fetchImpl, cacheMs: 60 * 60000, minIntervalMs: 400, retries: 1, timeoutMs: 25_000 });
    lastUpdated ??= j.meta?.last_updated ?? null;
    for (const r of j.results ?? []) { const l = readLetter(r); if (l) out.push(l); }
    if ((j.results ?? []).length < 100) break;
  }
  const seen = new Set<string>();
  return { letters: out.filter((l) => (seen.has(l.key) ? false : (seen.add(l.key), true))).sort((a, b) => b.date.localeCompare(a.date)), lastUpdated };
}
