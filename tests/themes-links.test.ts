import { describe, expect, it } from "vitest";
import { docLink, findQuote, guessQuoteLink, refUrl, THEMES_PROMPT } from "@/lib/scout/themes";

describe("theme quotes link to their source", () => {
  it("resolves the model's bracketed reference", () => {
    const refs = { D1: docLink("inbox/2026-11-22-discord-wsb.md"), W3: "https://example.com/a", T: "https://stocktwits.com/sentiment/trending" };
    expect(refUrl("[W3]", refs)).toBe("https://example.com/a");
    expect(refUrl("d1", refs)).toBe("/inbox/doc?path=inbox%2F2026-11-22-discord-wsb.md");
    expect(refUrl(undefined, refs)).toBeUndefined();
    expect(refUrl("X9", refs)).toBeUndefined();
    expect(THEMES_PROMPT).toMatch(/bracketed reference/);
  });

  it("finds older quotes by their text in a document, by the source's name, or by an article title", () => {
    const docs = [
      { path: "inbox/2026-11-21-discord-shkreli.md", text: "Polymarket post: Elon Musk warns the AI industry could face a massive cash shortage, he said." },
      { path: "inbox/2026-11-22-discord-wsb.md", text: "ECB relay. Something else entirely." },
    ];
    const arts = [{ url: "https://site/x", title: "Oracle default swaps widen to the highest since 2009" }];
    expect(guessQuoteLink({ text: "Elon Musk warns the AI industry could face a massive cash shortage", source: "discord shkreli, Polymarket post" }, docs, arts)).toBe(docLink(docs[0].path, "Elon Musk warns the AI industry could face a massive cash shortage"));
    expect(guessQuoteLink({ text: "a paraphrase that is not in any text at all here", source: "discord wsb, Nov 21 (unverified)" }, docs, arts)).toContain("discord-wsb");
    expect(guessQuoteLink({ text: "Oracle default swaps widen to the highest since 2009", source: "a website" }, docs, arts)).toBe("https://site/x");
    expect(guessQuoteLink({ text: "nothing matches this quote anywhere in the sources", source: "polymarket-pulse" }, docs, arts)).toBeUndefined();
  });

  it("highlights the quote in the document, ignoring case, quotes and line breaks", () => {
    const text = "Intro.\nAI infrastructure is increasingly\ndebt-funded, so a sentiment shift could spread losses.";
    const hit = findQuote(text, "“ai infrastructure is increasingly debt-funded, so a sentiment shift”");
    expect(hit && text.slice(hit.start, hit.end)).toMatch(/^AI infrastructure is increasingly\ndebt-funded, so a sentiment shift/);
    expect(findQuote(text, "not here at all, nothing")).toBeNull();
  });
});
