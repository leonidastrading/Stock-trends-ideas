/**
 * Is a headline in English? The press-release wires publish each release again in French, German, Chinese and other
 * languages, each as its own item with the same ticker, so one release showed up three or four times in the news
 * strip (YYForce, November 27, 2026). Only the English one is kept.
 *
 * Three tests, cheapest first: the wire's own link says the language (GlobeNewswire puts it in the address); the
 * headline is written in another script (Chinese, Japanese, Korean, Cyrillic, Arabic, Hebrew, Thai, Greek); or it is
 * in Latin letters but reads as French, German, Spanish, Portuguese, Italian or Dutch by its small words.
 */
const OTHER_SCRIPT = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;
const ENGLISH = new Set("the and for with from its to of in on at by is are was has have will that this as an new after over into says announces reports".split(" "));
const FOREIGN = new Set(("le la les des du une un pour avec aux sur dans est sont et son ses par grâce lance annonce mise jour " + // French
  "der die das und für mit den dem einen eine einem von zum zur bei wird ist sind bringt gibt bekannt neue neuen über " + // German
  "el los las una para con del por su sus anuncia lanza nueva nuevo en y que " + // Spanish
  "o os as uma com para do da dos das seu sua anuncia lança novo nova em e que " + // Portuguese
  "il lo gli le un una per con del della dei suo sua annuncia lancia nuovo nuova e che " + // Italian
  "het een voor met van op bij wordt zijn kondigt aan nieuwe en dat").split(" ").filter((w) => !ENGLISH.has(w)));

/** Pure: the language a wire's link names ("…/0/fr/…" on GlobeNewswire), or null when the link does not say. */
export function linkLanguage(url: string | null | undefined): string | null {
  const m = /globenewswire\.com\/(?:[a-z]{2}(?:-[a-z]+)?\/)?news-release\/\d{4}\/\d{2}\/\d{2}\/\d+\/\d+\/([a-z]{2}(?:-[a-z]+)?)\//i.exec(url ?? "") ?? /^https?:\/\/[^/]*globenewswire\.com\/([a-z]{2}(?:-[a-z]+)?)\/news-release\//i.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** Pure: is this headline English (by its link, its script, or its small words)? */
export function isEnglishHeadline(headline: string, url?: string | null): boolean {
  const lang = linkLanguage(url);
  if (lang) return lang === "en" || lang.startsWith("en-");
  const letters = headline.replace(/[^\p{L}]/gu, "");
  if (!letters.length) return true;
  if ((headline.match(OTHER_SCRIPT) ?? []).length / letters.length > 0.15) return false;
  const words = headline.toLowerCase().replace(/[^\p{L}\s'’-]/gu, " ").split(/\s+/).filter(Boolean);
  const en = words.filter((w) => ENGLISH.has(w)).length, other = words.filter((w) => FOREIGN.has(w)).length;
  // Reads as another language: two or more of its small words, and more of them than English ones.
  return !(other >= 2 && other > en);
}
