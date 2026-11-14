/** The research model call. Network side effects live here; prompt and parsing are pure modules. */
import Anthropic from "@anthropic-ai/sdk";
import { callCost } from "@/config/scout";
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

export type Purpose = "research" | "triage" | "stories" | "review";
export type CallModel = (args: { model: string; effort: Effort; user: string; purpose?: Purpose }) => Promise<ModelReply>;

const PROMPTS: Record<Purpose, { system: string; schema: Record<string, unknown> }> = {
  research: { system: SYSTEM_PROMPT, schema: CARD_JSON_SCHEMA as unknown as Record<string, unknown> },
  triage: { system: TRIAGE_SYSTEM_PROMPT, schema: TRIAGE_JSON_SCHEMA as unknown as Record<string, unknown> },
  stories: { system: STORY_SYSTEM_PROMPT, schema: STORY_JSON_SCHEMA as unknown as Record<string, unknown> },
  review: { system: REVIEW_SYSTEM_PROMPT, schema: REVIEW_JSON_SCHEMA as unknown as Record<string, unknown> },
};

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export const callResearchModel: CallModel = async ({ model, effort, user, purpose = "research" }) => {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment
  const { system, schema } = PROMPTS[purpose];
  const base = {
    model,
    max_tokens: 16000,
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: user }],
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
