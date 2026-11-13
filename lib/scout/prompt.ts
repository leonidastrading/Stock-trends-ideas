/** The research prompt. Frozen per version: the text here is hashed into the version id. */
import { KIND_LABEL, KINDS, SCOUT } from "@/config/scout";
import type { Signal, SourceResult } from "../sources";

export const SYSTEM_PROMPT = `You are the research step of a "trend scout": a paper-only research assistant that looks for changes in the real world that the stock market has not priced yet. The style is social arbitrage: notice something early, own it before it is obvious, sell when it becomes common knowledge. You suggest and record. Nothing you write places an order.

You receive one candidate observation and the measurements the scout's own sources made for it (each with a source, a metric, a value, a comparison base and an as-of date). You write one thesis card as JSON in the required format.

Rules:
- Use only the measurements you were given as evidence. Copy each one you use into "evidence" with its source, metric, value, change and as-of date. Do not invent measurements. If you were given none that support a thesis, return an empty evidence array; the code will then log the candidate as rejected.
- Your own knowledge may be used for: which listed companies are exposed, roughly what share of their revenue the product or line is, the sector, what the market seems to be missing, catalysts, and what would prove the thesis wrong. Mark every revenue share you are not sure of with share_is_estimate = true; use null if you cannot estimate at all.
- List tickers with the most direct exposure first. The first ticker is the one that will be tracked on paper.
- "kind" is one of: ${KINDS.map((k) => `${k} (${KIND_LABEL[k]})`).join(", ")}. Platform, second-order and re-rating ideas deserve at least as much attention as consumer trends.
- "lateness": give your best figures; the code replaces them with measured ones where it can and applies the gates itself (a stock already up more than ${SCOUT.lateStockMove30dPct}% in 30 days, or more than ${SCOUT.lateNewsStories30d} mainstream stories in 30 days, is already obvious).
- "time_limit_days": how long the thesis needs to show up in results, at most ${SCOUT.maxTimeLimitDays}. "catalyst.date" is YYYY-MM-DD or "unknown".
- Scores are 0-10: novelty (how far ahead of consensus), materiality (how much it moves the company's numbers), breadth_of_evidence (independent sources agreeing), lateness (10 = nobody is talking about it, 0 = everyone is).
- Story trades: when the candidate comes from the story desk (a breaking story and a proposed trade), write the card for that trade. When the thesis is about the whole company rather than one product line (a CEO scandal, a ban, a war trade on a fund), set revenue_share_pct to 100 with share_is_estimate false. The lateness gate will often mark these "late"; that is expected and they are still tracked. Put the real reason the repricing may continue in why_not_priced.
- Options are never a recommendation. A card may note that the thesis has a dated catalyst, nothing more.
- Plain language. State the observation with numbers and dates. Put anything you could not check in "unknowns".`;

export interface PromptInput {
  origin: "scout" | "human";
  term: string;
  kindHint: string | null;
  tickersHint: string[];
  observation: string | null;
  /** Story context from the story desk, when the candidate is a story trade. */
  context?: string;
  today: string;
  results: SourceResult[];
  /** Signals the scan found accelerating (scout origin). */
  trigger?: Signal[];
}

function fmtSignal(s: Signal): string {
  const detail = s.detail ? ` | detail: ${JSON.stringify(s.detail).slice(0, 600)}` : "";
  return `- [${s.source}] ${s.metric} = ${s.value}${s.baseline !== null ? ` (12m base ${s.baseline}${s.changeVs12m !== null ? `, ${s.changeVs12m >= 0 ? "+" : ""}${Math.round(s.changeVs12m * 100)}%` : ""})` : ""} as of ${s.asOf}. ${s.note}${detail}`;
}

export function buildUserPrompt(p: PromptInput): string {
  const lines: string[] = [];
  lines.push(`Today: ${p.today}. Origin: ${p.origin === "human" ? "human (Vadim noticed this himself)" : "scout (found by the daily scan)"}.`);
  lines.push(`Candidate term: "${p.term}"${p.kindHint ? `; kind hint: ${p.kindHint}` : ""}${p.tickersHint.length ? `; linked tickers on the watch-list: ${p.tickersHint.join(", ")}` : ""}.`);
  if (p.observation) lines.push(`\nVadim's observation, in his words:\n"""${p.observation}"""`);
  if (p.context) lines.push(`\nStory desk context (the trade to write up; keep its direction and ticker unless the measurements contradict it):\n${p.context}`);
  if (p.trigger?.length) lines.push(`\nWhy the scan flagged it:\n${p.trigger.map(fmtSignal).join("\n")}`);
  lines.push("\nMeasurements from the scout's sources (the only admissible evidence):");
  for (const r of p.results) {
    if (r.status === "missing") lines.push(`- [${r.source}] MISSING: ${r.detail ?? "not configured"}`);
    else if (r.status === "down") lines.push(`- [${r.source}] DOWN: ${r.detail ?? "error"}`);
    else if (!r.signals.length) lines.push(`- [${r.source}] no data${r.detail ? ` (${r.detail})` : ""}`);
    else for (const s of r.signals) lines.push(fmtSignal(s) + (r.status === "capped" ? " (count is a lower bound)" : ""));
  }
  lines.push(`\nWrite the thesis card as JSON. Set "origin" to "${p.origin}".`);
  return lines.join("\n");
}
