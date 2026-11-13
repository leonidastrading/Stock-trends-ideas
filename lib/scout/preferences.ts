/** Turn Vadim's thumbs up/down into a short block the discovery and story prompts can use. Pure. */
import type { Feedback } from "./store";

export function preferencesText(items: Array<Feedback & { about: string }>, max = 12): string | null {
  if (!items.length) return null;
  const line = (f: Feedback & { about: string }) => `- ${f.about}${f.note ? ` — "${f.note.slice(0, 160)}"` : ""}`;
  const up = items.filter((f) => f.vote === "up").slice(0, max);
  const down = items.filter((f) => f.vote === "down").slice(0, max);
  const L: string[] = ["Vadim's reactions to earlier cards and stories (steer towards what he liked, away from what he did not; his notes say why):"];
  if (up.length) L.push("Liked:", ...up.map(line));
  if (down.length) L.push("Did not like:", ...down.map(line));
  return L.join("\n");
}
