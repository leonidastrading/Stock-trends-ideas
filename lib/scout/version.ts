/** A version = sha256 of everything that shapes a card: model, effort, prompt, reply schema, gates, sources, candidate rules, baseline universe. */
import { SHARE_COUNT_REVISION } from "./share-count";
import { createHash } from "node:crypto";
import { LIGHT_MODEL, LIGHT_PURPOSES, SCOUT, SECTORS } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import { SOURCE_IDS, SOURCE_REVISIONS } from "../sources";
import { CARD_JSON_SCHEMA } from "./card";
import { TRIAGE_JSON_SCHEMA, TRIAGE_SYSTEM_PROMPT } from "./discovery";
import { STORY_JSON_SCHEMA, STORY_SYSTEM_PROMPT } from "./stories";
import { INBOX_JSON_SCHEMA, INBOX_SYSTEM_PROMPT } from "./inbox";
import { SYSTEM_PROMPT } from "./prompt";
import { KNOWN_REVISION } from "./known";
import { PRICE_CHECK_REVISION } from "./price-check";
import { CALL_REVISION } from "./earnings-call";

/** How a paper trade ends: at the card's time limit (or its invalidation). Before this, at the earlier of the day after the catalyst and the time limit. */
export const EXIT_RULE = "time_limit";
/** How a paper trade starts: at the live price when the card is written while the market is open, else the next open. */
export const ENTRY_RULE = "live_when_open";

export function versionSpec(model: string, effort: string) {
  return { model, effort, systemPrompt: SYSTEM_PROMPT, replySchema: CARD_JSON_SCHEMA, triagePrompt: TRIAGE_SYSTEM_PROMPT, triageSchema: TRIAGE_JSON_SCHEMA, storyPrompt: STORY_SYSTEM_PROMPT, storySchema: STORY_JSON_SCHEMA, inboxPrompt: INBOX_SYSTEM_PROMPT, inboxSchema: INBOX_JSON_SCHEMA, rules: SCOUT, sources: SOURCE_IDS, sourceRevisions: SOURCE_REVISIONS, sectors: SECTORS, universe: UNIVERSE, known: KNOWN_REVISION, priceCheck: PRICE_CHECK_REVISION, probeTerm: 2, earningsCall: CALL_REVISION, shareCount: SHARE_COUNT_REVISION, routing: { light: LIGHT_MODEL, purposes: LIGHT_PURPOSES }, exitRule: EXIT_RULE, entryRule: ENTRY_RULE };
}

export function versionHash(spec: unknown): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}
