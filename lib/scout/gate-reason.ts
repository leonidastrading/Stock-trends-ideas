/** Why a card was not promoted (or counts as late), in plain words, from its gate notes. Shown under the card's header. */

const NOT_PROMOTED: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^materiality: line is ([\d.]+)% of (\S+) revenue \(gate: ([\d.]+)%\)/, (m) => `the business it is about is only about ${m[1]}% of ${m[2]}'s revenue, too small to move the stock (a card needs at least ${m[3]}%)`],
  [/^materiality: no revenue-share estimate for (\S+)/, (m) => `no estimate of how much of ${m[1]}'s revenue the idea touches, so its size could not be checked`],
  [/^no US price data for (\S+)/, (m) => `${m[1]} has no US price data (not listed yet, or foreign), so it could not be tracked`],
  [/^short not promoted: (.+?);/, (m) => `a short after a run-up: ${m[1]}`],
  [/^no shorts under \$5: \$([\d.]+)/, (m) => `a short on a $${m[1]} stock: under $5 is hard and costly to borrow, and prone to squeezes`],
  [/^not promoted: (.+)/, (m) => m[1]],
];

const LATE: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(\d+) mainstream stories in 30 days \(gate: (\d+)/, (m) => `already widely covered: ${m[1]} mainstream stories in 30 days (the gate is ${m[2]})`],
  [/^stock up ([\d.]+)% in 30 days \(gate: ([\d.]+)%\)/, (m) => `the stock was already up ${m[1]}% in 30 days (the gate is ${m[2]}%)`],
  [/^model itself judged the idea already obvious/, () => "the scout itself judged the idea already obvious"],
];

/** Pure: the deciding reason, or null for a promoted card (or when no note explains it). */
export function gateReason(status: string, notes: string[]): string | null {
  const rules = status === "not_promoted" ? NOT_PROMOTED : status === "late" ? LATE : null;
  if (!rules) return null;
  for (const [re, say] of rules) for (const n of notes) { const m = n.match(re); if (m) return say(m); }
  if (status === "not_promoted") {
    const n = notes.find((x) => /not promoted|dropped|gate/i.test(x));
    return n ?? null;
  }
  return null;
}
