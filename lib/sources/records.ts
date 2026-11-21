/**
 * Public records for "follow the money" investigations. All free, all public:
 * - USAspending (api.usaspending.gov): federal contract awards by keyword or recipient.
 * - Lobbying Disclosure (lda.gov; the old lda.senate.gov answers 503 since late 2026): lobbying filings by client (who paid, how much, on what issues,
 *   which agencies). LDA_API_KEY optional (higher rate limit).
 * - FEC (api.open.fec.gov): a PAC's or campaign committee's spending, including contributions to candidates.
 *   FEC_API_KEY (free from api.data.gov) is optional; without it the shared DEMO_KEY is used, which is heavily rate-limited.
 * Each lookup returns rows with a link back to the record, never throws (errors come back as text).
 */
import { contractorTicker } from "../market/sources";

const UA = { "user-agent": "Mozilla/5.0 (compatible; research-reader/1.0)", accept: "application/json" };
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function getJson<T>(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- contracts

export interface ContractAward { awardId: string; recipient: string; ticker: string | null; amount: number; agency: string; subAgency: string; description: string; start: string; end: string; url: string }

/** Pure: USAspending's award rows. */
export function parseAwards(j: { results?: Array<Record<string, unknown>> }): ContractAward[] {
  return (j.results ?? []).map((r) => {
    const recipient = String(r["Recipient Name"] ?? "");
    const internal = String(r.generated_internal_id ?? "");
    return {
      awardId: String(r["Award ID"] ?? ""), recipient, ticker: contractorTicker(recipient, []) || null, amount: Number(r["Award Amount"] ?? 0),
      agency: String(r["Awarding Agency"] ?? ""), subAgency: String(r["Awarding Sub Agency"] ?? ""), description: String(r.Description ?? "").slice(0, 300),
      start: String(r["Start Date"] ?? ""), end: String(r["End Date"] ?? ""),
      url: internal ? `https://www.usaspending.gov/award/${encodeURIComponent(internal)}` : "https://www.usaspending.gov/search",
    };
  });
}

/** The largest contract awards in the last `years` matching a keyword (e.g. "air traffic control") or a recipient name. */
export async function contractAwards(q: { keyword?: string; recipient?: string }, fetchImpl: typeof fetch = fetch, now = new Date(), years = 3): Promise<ContractAward[]> {
  const filters: Record<string, unknown> = { award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: iso(new Date(now.getTime() - years * 365 * 86400_000)), end_date: iso(now) }] };
  if (q.keyword) filters.keywords = [q.keyword];
  if (q.recipient) filters.recipient_search_text = [q.recipient];
  const j = await getJson<{ results?: Array<Record<string, unknown>> }>("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
    method: "POST", headers: { ...UA, "content-type": "application/json" },
    body: JSON.stringify({ filters, fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Awarding Sub Agency", "Description", "Start Date", "End Date"], sort: "Award Amount", order: "desc", limit: 8, page: 1 }),
  }, fetchImpl);
  return parseAwards(j);
}

// ---------------------------------------------------------------- lobbying

export interface LobbyingFiling { client: string; registrant: string; year: number | null; period: string; amount: number | null; issues: string[]; agencies: string[]; specific: string; posted: string; url: string }

/** Pure: Senate LDA filings. */
export function parseLda(j: { results?: Array<Record<string, unknown>> }): LobbyingFiling[] {
  return (j.results ?? []).map((r) => {
    const acts = (r.lobbying_activities as Array<Record<string, unknown>> | undefined) ?? [];
    const income = r.income === null || r.income === undefined ? null : Number(r.income);
    const expenses = r.expenses === null || r.expenses === undefined ? null : Number(r.expenses);
    return {
      client: String((r.client as { name?: string } | undefined)?.name ?? ""), registrant: String((r.registrant as { name?: string } | undefined)?.name ?? ""),
      year: r.filing_year ? Number(r.filing_year) : null, period: String(r.filing_period_display ?? r.filing_period ?? ""),
      amount: income ?? expenses,
      issues: [...new Set(acts.map((a) => String(a.general_issue_code_display ?? "")).filter(Boolean))],
      agencies: [...new Set(acts.flatMap((a) => ((a.government_entities as Array<{ name?: string }> | undefined) ?? []).map((g) => String(g.name ?? ""))).filter(Boolean))].slice(0, 8),
      specific: acts.map((a) => String(a.description ?? "")).filter(Boolean).join(" | ").slice(0, 400),
      posted: String(r.dt_posted ?? "").slice(0, 10), url: String(r.filing_document_url ?? r.url ?? "https://lda.senate.gov/filings/public/filing/search/"),
    };
  });
}

/** Lobbying filings this year and last for a client (the company that paid for lobbying). */
export async function lobbyingFor(client: string, fetchImpl: typeof fetch = fetch, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<LobbyingFiling[]> {
  const headers: Record<string, string> = { ...UA };
  if (env.LDA_API_KEY?.trim()) headers.authorization = `Token ${env.LDA_API_KEY.trim()}`;
  const y = now.getUTCFullYear();
  const out: LobbyingFiling[] = [];
  for (const year of [y, y - 1]) {
    const qs = new URLSearchParams({ client_name: client, filing_year: String(year), page_size: "10" });
    // The lobbying database moved to lda.gov; the Senate address is tried only if the new one fails.
    let j: { results?: Array<Record<string, unknown>> };
    try {
      j = await getJson(`https://lda.gov/api/v1/filings/?${qs}`, { headers }, fetchImpl);
    } catch {
      j = await getJson(`https://lda.senate.gov/api/v1/filings/?${qs}`, { headers }, fetchImpl);
    }
    out.push(...parseLda(j));
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------- PAC and campaign money

export interface PacSpend { committee: string; committeeId: string; recipient: string; amount: number; date: string; purpose: string; candidate: string | null; url: string }

/** Pure: FEC schedule B (disbursements) rows. */
export function parseScheduleB(committee: string, committeeId: string, j: { results?: Array<Record<string, unknown>> }): PacSpend[] {
  return (j.results ?? []).map((r) => ({
    committee, committeeId, recipient: String(r.recipient_name ?? ""), amount: Number(r.disbursement_amount ?? 0), date: String(r.disbursement_date ?? "").slice(0, 10),
    purpose: String(r.disbursement_description ?? r.disbursement_purpose_category ?? ""), candidate: (r.candidate_name as string) || null,
    url: `https://www.fec.gov/data/disbursements/?committee_id=${committeeId}`,
  }));
}

/** A committee (a company's PAC, or a campaign) by name, and its latest spending (who it gave money to). */
export async function pacSpending(name: string, fetchImpl: typeof fetch = fetch, now = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ committees: Array<{ id: string; name: string; type: string }>; spending: PacSpend[] }> {
  const key = env.FEC_API_KEY?.trim() || "DEMO_KEY";
  const base = "https://api.open.fec.gov/v1";
  const c = await getJson<{ results?: Array<{ committee_id: string; name: string; committee_type_full?: string }> }>(`${base}/committees/?${new URLSearchParams({ q: name, per_page: "5", api_key: key })}`, { headers: UA }, fetchImpl);
  const committees = (c.results ?? []).map((x) => ({ id: x.committee_id, name: x.name, type: x.committee_type_full ?? "" }));
  const spending: PacSpend[] = [];
  const cycle = String(now.getUTCFullYear() % 2 === 0 ? now.getUTCFullYear() : now.getUTCFullYear() + 1);
  for (const cm of committees.slice(0, 2)) {
    const b = await getJson<{ results?: Array<Record<string, unknown>> }>(`${base}/schedules/schedule_b/?${new URLSearchParams({ committee_id: cm.id, two_year_transaction_period: cycle, per_page: "40", sort: "-disbursement_date", api_key: key })}`, { headers: UA }, fetchImpl);
    spending.push(...parseScheduleB(cm.name, cm.id, b));
  }
  return { committees, spending };
}
