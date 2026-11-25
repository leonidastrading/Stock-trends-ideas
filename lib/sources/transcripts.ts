/**
 * Earnings call transcripts, from Alpha Vantage (EARNINGS_CALL_TRANSCRIPT; free key, about 25 requests a day).
 * A call is asked for by ticker and fiscal quarter, where the fiscal year is named by the calendar year it ENDS in:
 * Nvidia's quarter to late October 2026 is "2027Q3", Microsoft's to September 2026 is "2027Q1". Coverage is good
 * for large companies within days of the call and patchy for small ones (Ambarella's last two calls were missing
 * on Nov 25, 2026), so a miss is normal and is asked again later.
 *
 * The model is not handed the whole call (30 to 50 thousand characters). Code picks out what a press release does
 * not carry: management's forward-looking sentences, and the analysts' questions with the start of each answer.
 */
import { getJson } from "../http";

export interface CallTurn { speaker: string; title: string; content: string }

/** Pure: the Alpha Vantage quarter label for the fiscal quarter a company reported on `reportDate`. `fye` is the SEC's fiscal year end, "MMDD". */
export function fiscalLabel(fye: string, reportDate: string): string | null {
  const m = /^(\d{2})(\d{2})$/.exec(fye.trim());
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return null;
  // A year that ends in the first days of a month (52-week retailers: "0201") really ends with the month before.
  let endMonth = Number(m[1]) - (Number(m[2]) < 15 ? 1 : 0);
  if (endMonth < 1) endMonth += 12;
  if (endMonth > 12) return null;
  // The quarter reported is the latest one that ended at least a week before the report.
  const report = Date.parse(`${reportDate}T12:00:00Z`) - 7 * 86400_000;
  const y0 = Number(reportDate.slice(0, 4));
  let best: { year: number; month: number } | null = null;
  // Fiscal years ending this year, last year and next (a quarter to October belongs to the year ending next January).
  for (let y = y0 - 1; y <= y0 + 1; y++) for (let k = 0; k < 4; k++) {
    let month = endMonth - 3 * k, year = y;
    if (month < 1) { month += 12; year -= 1; }
    const end = Date.UTC(year, month, 0, 12); // the last day of that month
    if (end <= report && (!best || end > Date.UTC(best.year, best.month, 0, 12))) best = { year, month };
  }
  if (!best) return null;
  // Months from the quarter's end to the fiscal year's end, and the calendar year that end falls in.
  const ahead = (endMonth - best.month + 12) % 12;
  const quarter = 4 - ahead / 3;
  const fyYear = best.month + ahead > 12 ? best.year + 1 : best.year;
  return Number.isInteger(quarter) && quarter >= 1 && quarter <= 4 ? `${fyYear}Q${quarter}` : null;
}

const FORWARD = /\b(guidance|outlook|expect\w*|anticipat\w*|forecast\w*|next quarter|full[- ]year|fiscal 20\d\d|headwinds?|tailwinds?|demand|pricing|price increases?|margins?|inventor\w+|backlog|bookings|pipeline|supply|shortage|constraints?|tariffs?|capex|capital expenditures?|buyback|repurchase|dividend|restructur\w+|layoffs?|strategic (?:alternatives|review)|acquisition|merger|churn|visibility|soft(?:er|ness)?|weak(?:er|ness)?|accelerat\w+|decelerat\w+|record)\b/i;
const isAnalyst = (t: CallTurn) => /analyst/i.test(t.title) && !/investor relations|\bIR\b/i.test(t.title);
const isOperator = (t: CallTurn) => /^operator$/i.test(t.speaker.trim()) || /^operator$/i.test(t.title.trim());
const sentences = (s: string) => s.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9$])/).map((x) => x.trim()).filter((x) => x.length >= 40);

export const CALL = { remarksChars: 3200, questions: 8, questionChars: 260, answerChars: 420, maxChars: 8500 };

/** Pure: what the call adds to the press release: forward-looking remarks, then the analysts' questions with how each answer began. */
export function callDigest(turns: CallTurn[], cfg = CALL): string | null {
  const real = turns.filter((t) => t.content?.trim() && !isOperator(t));
  if (real.length < 3) return null;
  const firstQ = real.findIndex(isAnalyst);
  const prepared = firstQ > 0 ? real.slice(0, firstQ) : real.slice(0, Math.min(real.length, 4));
  const remarks: string[] = [];
  let used = 0;
  for (const t of prepared) {
    for (const s of sentences(t.content)) {
      // Safe-harbour boilerplate uses the same words and says nothing.
      if (!FORWARD.test(s) || /forward-looking statements|safe harbor|non-GAAP financial measures|risks and uncertainties/i.test(s)) continue;
      if (used + s.length > cfg.remarksChars) break;
      remarks.push(`${t.speaker.split(" ").at(-1)}: ${s}`);
      used += s.length;
    }
  }
  const qa: string[] = [];
  if (firstQ > 0) {
    for (let i = firstQ; i < real.length && qa.length < cfg.questions; i++) {
      if (!isAnalyst(real[i])) continue;
      const q = real[i].content.replace(/\s+/g, " ").trim();
      if (q.length < 40) continue; // "Thank you", "Great, thanks"
      const a = real.slice(i + 1).find((t) => !isAnalyst(t));
      qa.push(`Q (${real[i].speaker}${real[i].title ? `, ${real[i].title.replace(/\s+/g, " ").slice(0, 40)}` : ""}): ${q.slice(0, cfg.questionChars)}${q.length > cfg.questionChars ? "…" : ""}${a ? `\n  A (${a.speaker.split(" ").at(-1)}): ${a.content.replace(/\s+/g, " ").trim().slice(0, cfg.answerChars)}…` : ""}`);
    }
  }
  if (!remarks.length && !qa.length) return null;
  return [remarks.length ? `Management, looking ahead:\n${remarks.map((r) => `- ${r}`).join("\n")}` : "", qa.length ? `Analysts asked:\n${qa.join("\n")}` : ""].filter(Boolean).join("\n\n").slice(0, cfg.maxChars);
}

export type CallFetch = { turns: CallTurn[] } | { limited: string };

/** One call from Alpha Vantage. An empty list means it has no transcript for that quarter (yet); `limited` means the day's quota is used. */
export async function fetchCall(symbol: string, label: string, key: string, fetchImpl?: typeof fetch): Promise<CallFetch> {
  const j = await getJson<{ transcript?: Array<Partial<CallTurn>>; Information?: string; Note?: string; "Error Message"?: string }>(
    `https://www.alphavantage.co/query?function=EARNINGS_CALL_TRANSCRIPT&symbol=${encodeURIComponent(symbol)}&quarter=${encodeURIComponent(label)}&apikey=${encodeURIComponent(key)}`,
    { fetchImpl, cacheMs: 0, minIntervalMs: 1300, retries: 0, timeoutMs: 25_000 },
  );
  const refusal = j.Information ?? j.Note ?? j["Error Message"];
  if (refusal && !j.transcript) return { limited: String(refusal).slice(0, 160) };
  return { turns: (j.transcript ?? []).map((t) => ({ speaker: String(t.speaker ?? ""), title: String(t.title ?? ""), content: String(t.content ?? "") })) };
}
