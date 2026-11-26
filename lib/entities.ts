/**
 * HTML entities in text from feeds and pages, decoded in one place ("Trump&#39;s" → "Trump's", "AT&amp;T" → "AT&T",
 * "&#8217;" and "&rsquo;" → "’", "&mdash;" → "—"). Text that was encoded twice ("&amp;#39;", "&amp;amp;") is decoded
 * twice. Each reader used to carry its own short list, so the entities the list missed showed up on the page.
 */
const NAMED: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", trade: "™", reg: "®", copy: "©",
  euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", middot: "·", bull: "•", times: "×", frac12: "½", eacute: "é", egrave: "è", aacute: "á", oacute: "ó", uuml: "ü", ouml: "ö", auml: "ä", ntilde: "ñ", ccedil: "ç", shy: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

function once(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (m, n) => { const c = Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; })
    .replace(/&([a-z][a-z0-9]{1,7});/gi, (m, n) => NAMED[n] ?? NAMED[n.toLowerCase()] ?? m);
}

/** Pure: the text with its HTML entities decoded (twice, for text that was encoded twice). */
export function decodeEntities(s: string): string {
  if (!s || !s.includes("&")) return s;
  const a = once(s);
  return a.includes("&") ? once(a) : a;
}
