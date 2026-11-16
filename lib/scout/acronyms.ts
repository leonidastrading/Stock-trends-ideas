/**
 * Telling a product or program acronym from a ticker: "Intelligent Agreement Management (IAM)" is DocuSign's product,
 * even though some company trades as IAM. Pure helpers, used in the browser and on the server.
 */

const CONNECT = new Set(["of", "and", "for", "the", "&", "to", "in", "on", "de"]);

/**
 * Pure: acronyms spelled out in the text, by the initials of a run of capitalised words ("Intelligent Agreement
 * Management" → IAM; "Department of Energy" → DOE). Only acronyms that also appear on their own in the text count.
 */
export function acronymPhrases(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set(text.match(/\b[A-Z]{2,5}\b/g) ?? []);
  if (!used.size) return out;
  const tokens = text.split(/[^A-Za-z&'-]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[A-Z][a-z]/.test(tokens[i])) continue;
    let initials = "";
    const words: string[] = [];
    for (let j = i; j < tokens.length && words.length < 8; j++) {
      const t = tokens[j];
      if (/^[A-Z][a-z]/.test(t)) { initials += t[0]; words.push(t); }
      else if (CONNECT.has(t.toLowerCase()) && words.length) { words.push(t); continue; }
      else break;
      if (initials.length >= 2 && used.has(initials) && !out.has(initials)) out.set(initials, words.join(" "));
      // Initials including the connectors' letters too ("Department of Energy" → DOE).
      const withConnectors = words.map((w) => w[0].toUpperCase()).join("");
      if (withConnectors.length >= 2 && used.has(withConnectors) && !out.has(withConnectors)) out.set(withConnectors, words.join(" "));
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\b(inc|corp|corporation|co|ltd|plc|sa|nv|ag|the|class [a-z]|common stock|ordinary shares|holdings?|group)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Pure: does a spelled-out phrase name the listed company ("Advanced Micro Devices" ~ "Advanced Micro Devices, Inc.")? */
export function phraseIsCompany(phrase: string, listingName: string): boolean {
  const p = norm(phrase), n = norm(listingName);
  if (!p || !n) return false;
  return n.startsWith(p) || p.startsWith(n) || n.split(" ").slice(0, 2).join(" ") === p.split(" ").slice(0, 2).join(" ");
}

/** Pure: words that look like tickers but are spelled out as something other than the listed company. */
export function notTickers(texts: string[], names: Record<string, string>, keep: Iterable<string> = []): Set<string> {
  const phrases = acronymPhrases(texts.join("\n"));
  const k = new Set(keep);
  const out = new Set<string>();
  for (const [acr, phrase] of phrases) {
    if (k.has(acr)) continue;
    const name = names[acr];
    if (!name || !phraseIsCompany(phrase, name)) out.add(acr);
  }
  return out;
}
