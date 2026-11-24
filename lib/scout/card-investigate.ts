/** Pure: what an investigation started from a card is asked to look into (the card's own claims, to check and follow). */
export function cardInvestigationText(c: { id: number; title: string; ticker: string; company?: string | null; direction: "long" | "short"; thesis?: string | null; observation?: string | null; whyNotPriced?: string | null; unknowns?: string[] }): string {
  const line = (label: string, v: string | null | undefined) => (v && v.trim() ? `${label}: ${v.trim()}` : "");
  return [
    `Investigate the story behind the scout's card #${c.id} (/cards/${c.id}): "${c.title}".`,
    "Check the card's claims against public records and follow the leads: who else is exposed, what the card missed, and whether the facts hold.",
    `The card is ${c.direction} ${c.ticker}${c.company ? ` (${c.company})` : ""}.`,
    line("Thesis", c.thesis),
    line("What was observed", c.observation),
    line("Why the card says it is not priced in", c.whyNotPriced),
    c.unknowns?.length ? `What the card could not check: ${c.unknowns.join("; ")}` : "",
  ].filter(Boolean).join("\n").slice(0, 6000);
}
