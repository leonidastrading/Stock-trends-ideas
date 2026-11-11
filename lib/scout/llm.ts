/** The research model call. Network side effects live here; prompt and parsing are pure modules. */
import Anthropic from "@anthropic-ai/sdk";
import { callCost } from "@/config/scout";
import { CARD_JSON_SCHEMA } from "./card";
import { SYSTEM_PROMPT } from "./prompt";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelReply {
  text: string;
  stopReason: string | null;
  modelServed: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  costUsd: number | null;
}

export type CallModel = (args: { model: string; effort: Effort; user: string }) => Promise<ModelReply>;

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export const callResearchModel: CallModel = async ({ model, effort, user }) => {
  const client = new Anthropic(); // ANTHROPIC_API_KEY from the environment
  const resp = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: { type: "json_schema", schema: CARD_JSON_SCHEMA as unknown as Record<string, unknown> } },
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
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
