/** A version = sha256 of everything that shapes a card: model, effort, prompt, reply schema, gates, sources, candidate rules, baseline universe. */
import { createHash } from "node:crypto";
import { SCOUT, SECTORS } from "@/config/scout";
import { UNIVERSE } from "@/config/universe";
import { SOURCE_IDS, SOURCE_REVISIONS } from "../sources";
import { CARD_JSON_SCHEMA } from "./card";
import { TRIAGE_JSON_SCHEMA, TRIAGE_SYSTEM_PROMPT } from "./discovery";
import { SYSTEM_PROMPT } from "./prompt";

export function versionSpec(model: string, effort: string) {
  return { model, effort, systemPrompt: SYSTEM_PROMPT, replySchema: CARD_JSON_SCHEMA, triagePrompt: TRIAGE_SYSTEM_PROMPT, triageSchema: TRIAGE_JSON_SCHEMA, rules: SCOUT, sources: SOURCE_IDS, sourceRevisions: SOURCE_REVISIONS, sectors: SECTORS, universe: UNIVERSE };
}

export function versionHash(spec: unknown): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}
