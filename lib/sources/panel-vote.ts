/**
 * Reading an FDA advisory panel's vote out of a company's own filing text (a 10-Q, 10-K or press release).
 *
 * Before the FDA decides on a drug it often asks a panel of outside experts to vote. Companies report the vote in
 * their filings in a handful of shapes: "voted 12 to 5 in favor of approving", "voted 9-4 that the benefits did not
 * outweigh the risks", "voted six in favor and thirteen against", "(Vote: 2 Yes, 21 No)", "voted to recommend not
 * approving". Pure code, no AI: a sentence it cannot place on one side is left out rather than guessed.
 */

const WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const N = `(\\d{1,2}|${Object.keys(WORDS).join("|")})`;
const num = (s: string): number | undefined => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE = new RegExp(`(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "gi");
const iso = (m: RegExpMatchArray) => `${m[3]}-${String(MONTHS.split("|").findIndex((x) => x.toLowerCase() === m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;

/** "12 to 5", "12-5", "12 (yes) to 5 (no)", "12 yes and 5 no", "six in favor and thirteen against", "8 against, and 7 in favor". */
const PAIR = new RegExp(`\\b${N}\\s*(?:\\(?"?(yes|no|for|against|in favou?r)"?\\)?\\s*(?:votes?)?\\s*)?(?:,|and|to|-|–|—|vs\\.?|versus)\\s*(?:and\\s+)?${N}\\b(?:\\s*\\(?"?(yes|no|for|against|in favou?r)\\b)?`, "gi");
const OF = new RegExp(`\\b${N}\\s+(?:out\\s+)?of\\s+(?:the\\s+)?${N}\\b`, "gi");
/** Shareholder and board votes are not panel votes. */
const NOT_A_PANEL = /stockholder|shareholder|annual meeting|special meeting|proxy|say-on-pay|executive compensation|broker non-votes|directors? voted/i;
/** A statement the panel voted ON that is itself negative ("did not outweigh", "recommend not approving"). */
const NEGATIVE = /\bnot (?:to )?(?:approv|recommend|support|be approved)|recommend(?:ed|ing)? (?:not|against)|against (?:the )?(?:approval|recommend|approving)|\b(?:did|does|do|were|was|is|are|has|have|had) not\b|insufficient|unfavou?rable|failed to/i;
/** ...except "the risks do not outweigh the benefits", which is the favourable way round. */
const RISKS_DO_NOT = /risks? (?:do|does|did) not outweigh/i;
const AFTER_NEG = /^\W{0,3}(?:\(?\s*with[^,)]{0,40}abstain\w*\)?,?\s*)?(?:against|not to|no\b|in the negative)/i;

export interface PanelVoteRead {
  side: "positive" | "negative" | "split";
  /** The count for and against, when the text gives one (null for "voted against" with no numbers). */
  yes: number | null; no: number | null;
  /** The date the text gives just before the vote ("On July 30, 2026, the committee voted..."), when it gives one. */
  said: string | null;
  /** The sentence, for a person to check. */
  sentence: string;
}

/** Pure: every panel vote the text reports, in the order it reports them. */
export function panelVotesIn(text: string): PanelVoteRead[] {
  const x = text.replace(/\s+/g, " ");
  const out: PanelVoteRead[] = [];
  const seen = new Set<string>();
  for (const m of x.matchAll(/\b(?:voted|votes|vote of|vote was|vote:|tally)/gi)) {
    const at = m.index ?? 0;
    const lead = x.slice(Math.max(0, at - 500), at);
    const win = x.slice(at, at + 260);
    if (NOT_A_PANEL.test(lead.slice(-250) + win)) continue;
    if (!/advisory|adcom|\bpanel\b|committee/i.test(lead + win)) continue;
    const stop = win.search(/\.\s+[A-Z]/);
    const sent = (stop > 0 ? win.slice(0, stop + 1) : win).replace(/(yes|no) ?[/] ?/gi, "$1, ");
    let yes: number | null = null, no: number | null = null, side: PanelVoteRead["side"] | null = null;
    const pair = [...sent.matchAll(PAIR)].find((q) => {
      const a = num(q[1]), b = num(q[3]);
      // Two numbers joined by a comma or "and" are only a vote when one is labelled ("12 yes and 5 no").
      return a !== undefined && b !== undefined && a + b >= 4 && a + b <= 40 && (q[2] || q[4] || !/,|\band\b/i.test(q[0]));
    });
    if (pair) {
      const a = num(pair[1])!, b = num(pair[3])!;
      const l1 = (pair[2] ?? "").toLowerCase(), l2 = (pair[4] ?? "").toLowerCase();
      const tail = sent.slice((pair.index ?? 0) + pair[0].length, (pair.index ?? 0) + pair[0].length + 200);
      const negative = (NEGATIVE.test(tail.slice(0, 110)) && !RISKS_DO_NOT.test(tail.slice(0, 110))) || AFTER_NEG.test(tail);
      if (/no|against/.test(l1) && !/no|against/.test(l2)) { yes = b; no = a; }
      else if (l1 || l2) { yes = a; no = b; }
      // "voted 9-4 that the benefits did not outweigh the risks": the larger number backed the negative statement.
      else if (negative) { yes = Math.min(a, b); no = Math.max(a, b); }
      else { yes = a; no = b; }
    } else {
      const of = [...sent.matchAll(OF)].find((q) => { const a = num(q[1]), b = num(q[2]); return a !== undefined && b !== undefined && b >= 4 && b <= 40 && a <= b; });
      const against = /\bvot\w+\s+(?:unanimously\s+)?(?:against|not to recommend|no\b)/i.test(sent) || (NEGATIVE.test(sent.slice(0, 200)) && !RISKS_DO_NOT.test(sent));
      const favor = !against && (/\bvot\w+\s+(?:unanimously\s+)?(?:in favou?r|to recommend|for (?:the )?approval|yes\b|to approve|in support)/i.test(sent) || (/unanimous/i.test(sent) && /in favou?r|recommend|support|favou?rable|approv/i.test(sent)));
      if (of) { const a = num(of[1])!, b = num(of[2])!; if (against) { yes = b - a; no = a; } else { yes = a; no = b - a; } }
      else if (against) side = "negative";
      else if (favor) side = "positive";
      else continue;
    }
    side ??= yes! > no! ? "positive" : yes! < no! ? "negative" : "split";
    let said: string | null = null;
    for (const d of lead.slice(-260).matchAll(DATE)) said = iso(d);
    const sentence = (lead.slice(-200).replace(/^.*?[.;]\s+(?=[A-Z])/, "") + sent).trim().slice(0, 420);
    const key = `${side}|${yes}|${no}|${sent.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ side, yes, no, said, sentence });
  }
  return out;
}

/**
 * Pure: the one vote to show for a pending decision. Votes older than `sinceDate` are history (an earlier drug or an
 * earlier review); among the rest the latest dated one wins, a counted vote over an uncounted one. Votes that
 * disagree with each other on the same date (several questions) are shown as split.
 */
export function latestPanelVote(text: string, sinceDate: string): PanelVoteRead | null {
  const votes = panelVotesIn(text).filter((v) => !v.said || v.said >= sinceDate);
  if (!votes.length) return null;
  const dated = votes.filter((v) => v.said).sort((a, b) => b.said!.localeCompare(a.said!));
  const pool = dated.length ? dated.filter((v) => v.said === dated[0].said) : votes;
  const best = pool.find((v) => v.yes !== null) ?? pool[0];
  const sides = new Set(pool.filter((v) => v.side !== "split").map((v) => v.side));
  return sides.size > 1 ? { ...best, side: "split" } : best;
}

/** Pure: "3–9 against" / "12–5 in favour" / "against (no count given)". */
export function panelVoteLabel(v: Pick<PanelVoteRead, "side" | "yes" | "no">): string {
  const word = v.side === "negative" ? "against" : v.side === "positive" ? "in favour" : "split";
  return v.yes !== null && v.no !== null ? `${v.yes}–${v.no} ${word}` : `${word} (no count given)`;
}
