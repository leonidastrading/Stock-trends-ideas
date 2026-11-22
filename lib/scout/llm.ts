/** The research model call. Network side effects live here; prompt and parsing are pure modules. */
import { INBOX_JSON_SCHEMA, INBOX_SYSTEM_PROMPT } from "./inbox";
import { INBOX_DIGEST_PROMPT, INBOX_DIGEST_SCHEMA } from "./inbox-digest";
import { TRUTH_PROMPT, TRUTH_SCHEMA } from "./truth";
import { RUMORS_PROMPT, RUMORS_SCHEMA } from "./rumors";
import { EARN_PROMPT, EARN_SCHEMA } from "./earnings";
import { RUMOR_CHECK_PROMPT, RUMOR_CHECK_SCHEMA } from "./rumor-check";
import { INVALIDATION_PROMPT, INVALIDATION_SCHEMA } from "./invalidation";
import { THEMES_PROMPT, THEMES_SCHEMA } from "./themes";
import { DOTS_PROMPT, DOTS_SCAN_PROMPT, DOTS_SCAN_SCHEMA, DOTS_SCHEMA } from "./dots";
import { IMAGE_PROMPT, IMAGE_SCHEMA } from "./image-read";
import { FILING_DIFF_PROMPT, FILING_DIFF_SCHEMA } from "./filing-diff";
import { READTHROUGH_PROMPT, READTHROUGH_SCHEMA } from "./readthrough";
import { SITE_DIGEST_PROMPT, SITE_DIGEST_SCHEMA } from "./site-digest";
import { INVESTIGATE_LEADS_PROMPT, INVESTIGATE_LEADS_SCHEMA, INVESTIGATE_PLAN_PROMPT, INVESTIGATE_PLAN_SCHEMA, INVESTIGATE_REPORT_PROMPT, INVESTIGATE_REPORT_SCHEMA } from "./investigate";
import Anthropic from "@anthropic-ai/sdk";
import { callCost, modelFor } from "@/config/scout";
import { RECHECK_PROMPT, RECHECK_SCHEMA } from "./recheck";
import { BUBBLE_PROMPT, BUBBLE_SCHEMA } from "./bubbles";
import { CARD_JSON_SCHEMA } from "./card";
import { TRIAGE_JSON_SCHEMA, TRIAGE_SYSTEM_PROMPT } from "./discovery";
import { SYSTEM_PROMPT } from "./prompt";
import { REVIEW_JSON_SCHEMA, REVIEW_SYSTEM_PROMPT } from "./review";
import { STORY_JSON_SCHEMA, STORY_SYSTEM_PROMPT } from "./stories";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelReply {
  text: string;
  stopReason: string | null;
  modelServed: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  costUsd: number | null;
}

export type Purpose = "research" | "triage" | "stories" | "review" | "inbox" | "inbox_digest" | "truth" | "rumors" | "investigate_plan" | "investigate_leads" | "investigate_report" | "filing_diff" | "readthrough" | "site_digest" | "earnings_card" | "rumor_check" | "invalidation" | "themes" | "image_read" | "dots" | "dots_scan" | "recheck" | "bubbles";
export type CallModel = (args: { model: string; effort: Effort; user: string; purpose?: Purpose; images?: Array<{ mediaType: string; data: string }> }) => Promise<ModelReply>;

const PROMPTS: Record<Purpose, { system: string; schema: Record<string, unknown> }> = {
  research: { system: SYSTEM_PROMPT, schema: CARD_JSON_SCHEMA as unknown as Record<string, unknown> },
  triage: { system: TRIAGE_SYSTEM_PROMPT, schema: TRIAGE_JSON_SCHEMA as unknown as Record<string, unknown> },
  stories: { system: STORY_SYSTEM_PROMPT, schema: STORY_JSON_SCHEMA as unknown as Record<string, unknown> },
  review: { system: REVIEW_SYSTEM_PROMPT, schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown> },
  inbox: { system: INBOX_SYSTEM_PROMPT, schema: INBOX_JSON_SCHEMA as unknown as Record<string, unknown> },
  inbox_digest: { system: INBOX_DIGEST_PROMPT, schema: INBOX_DIGEST_SCHEMA as unknown as Record<string, unknown> },
  truth: { system: TRUTH_PROMPT, schema: TRUTH_SCHEMA as unknown as Record<string, unknown> },
  rumors: { system: RUMORS_PROMPT, schema: RUMORS_SCHEMA as unknown as Record<string, unknown> },
  investigate_plan: { system: INVESTIGATE_PLAN_PROMPT, schema: INVESTIGATE_PLAN_SCHEMA as unknown as Record<string, unknown> },
  image_read: { system: IMAGE_PROMPT, schema: IMAGE_SCHEMA as unknown as Record<string, unknown> },
  dots_scan: { system: DOTS_SCAN_PROMPT, schema: DOTS_SCAN_SCHEMA as unknown as Record<string, unknown> },
  dots: { system: DOTS_PROMPT, schema: DOTS_SCHEMA as unknown as Record<string, unknown> },
  themes: { system: THEMES_PROMPT, schema: THEMES_SCHEMA as unknown as Record<string, unknown> },
  bubbles: { system: BUBBLE_PROMPT, schema: BUBBLE_SCHEMA as unknown as Record<string, unknown> },
  recheck: { system: RECHECK_PROMPT, schema: RECHECK_SCHEMA as unknown as Record<string, unknown> },
  invalidation: { system: INVALIDATION_PROMPT, schema: INVALIDATION_SCHEMA as unknown as Record<string, unknown> },
  rumor_check: { system: RUMOR_CHECK_PROMPT, schema: RUMOR_CHECK_SCHEMA as unknown as Record<string, unknown> },
  earnings_card: { system: EARN_PROMPT, schema: EARN_SCHEMA as unknown as Record<string, unknown> },
  filing_diff: { system: FILING_DIFF_PROMPT, schema: FILING_DIFF_SCHEMA as unknown as Record<string, unknown> },
  site_digest: { system: SITE_DIGEST_PROMPT, schema: SITE_DIGEST_SCHEMA as unknown as Record<string, unknown> },
  readthrough: { system: READTHROUGH_PROMPT, schema: READTHROUGH_SCHEMA as unknown as Record<string, unknown> },
  investigate_leads: { system: INVESTIGATE_LEADS_PROMPT, schema: INVESTIGATE_LEADS_SCHEMA as unknown as Record<string, unknown> },
  investigate_report: { system: INVESTIGATE_REPORT_PROMPT, schema: INVESTIGATE_REPORT_SCHEMA as unknown as Record<string, unknown> },
};

/** Models that accept the server-side refusal fallback. */
export const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export const callResearchModel: CallModel = async ({ model: chosen, effort, user, purpose = "research", images }) => {
  // Bulk purposes run on the cheaper model; the cost below is priced on the model actually called.
  const model = modelFor(purpose, chosen);
  const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment
  const { system, schema } = PROMPTS[purpose];
  const base = {
    model,
    max_tokens: 16000,
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    // Images (base64) go before the text, as the API recommends.
    // A PDF (a scanned one, with no text layer) goes as a document block.
    messages: [{ role: "user" as const, content: images?.length ? [...images.map((im) => im.mediaType === "application/pdf" ? ({ type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: im.data } }) : ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType as "image/jpeg", data: im.data } })), { type: "text" as const, text: user }] : user }],
    output_config: { effort, format: { type: "json_schema" as const, schema } },
  };
  let resp: Anthropic.Beta.BetaMessage;
  try {
    resp = await client.beta.messages.create({ ...base, ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}) });
  } catch (err) {
    // If the account or platform rejects the refusal-fallback option, send the same request without it.
    const msg = err instanceof Error ? err.message : String(err);
    if (!(err instanceof Anthropic.BadRequestError) || !/fallback|beta/i.test(msg)) throw err;
    resp = await client.beta.messages.create(base);
  }
  if (resp.stop_reason === "refusal") throw new Error("model refused the request");
  if (resp.stop_reason === "max_tokens") throw new Error("reply truncated (max_tokens)");
  const text = resp.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const usage = {
    input_tokens: resp.usage.input_tokens,
    output_tokens: resp.usage.output_tokens,
    cache_read_input_tokens: resp.usage.cache_read_input_tokens,
    cache_creation_input_tokens: resp.usage.cache_creation_input_tokens,
  };
  return { text, stopReason: resp.stop_reason, modelServed: resp.model, usage, costUsd: callCost(model, usage) };
};
