import { describe, expect, it } from "vitest";
import { docLabel, originTag } from "@/lib/scout/origin-tag";

describe("where a card's idea came from", () => {
  it("names the inbox document's kind", () => {
    const obs = (doc: string) => `Hunger Games opens Nov 20. (From the inbox document "${doc}"; your bot read it)`;
    expect(docLabel(obs("2026-11-19-youtube"))).toBe("2026-11-19-youtube");
    expect(originTag("human", "inbox: IMAX share of Hunger Games opening", obs("2026-11-19-youtube")).tag).toBe("YouTube");
    expect(originTag("human", "inbox: x", obs("2026-11-19-discord-wsb-4")).tag).toBe("Discord");
    expect(originTag("human", "inbox: x", obs("notes")).tag).toBe("Inbox doc");
  });
  it("names the scout's desks and your own routes", () => {
    expect(originTag("scout", "story: AMD export probe").tag).toBe("News scan");
    expect(originTag("scout", "insider: ACME CEO buys").tag).toBe("Insider buy");
    expect(originTag("scout", "rumor: AMD #64 claim").tag).toBe("Rumors");
    expect(originTag("scout", "dots: outage panic buying").tag).toBe("Dots");
    expect(originTag("scout", "generators").tag).toBe("Trend scan");
    expect(originTag("scout", "site: ZeroHedge story", 'Story. (From ZeroHedge; the scout read it)').tag).toBe("ZeroHedge");
    expect(originTag("human", "court: class action DUOL").tag).toBe("Court");
    expect(originTag("human", "REGN FDA Dec 2026: drug").tag).toBe("Pharma");
    expect(originTag("human", "costco generators", "I saw generators sold out").tag).toBe("Your note");
  });
});

describe("the origin links back to where the idea came from", () => {
  it("uses the page that sent it, then works older cards out from their term", async () => {
    const { originLink } = await import("@/lib/scout/origin-tag");
    expect(originLink("human", "dots: port strike", "long text", { label: "Dots", url: "/dots?run=12#dot-121" })).toMatchObject({ tag: "Dots", url: "/dots?run=12#dot-121" });
    expect(originLink("human", "costco generators", "I saw generators sold out", { label: "Your note", url: "/notice" })).toMatchObject({ tag: "Your note" });
    expect(originLink("scout", "rumor: AMD #64 claim").url).toBe("/rumors?id=64#rumor-64");
    expect(originLink("scout", "investigate: PANW #7 outage rules").url).toBe("/investigate#inv-7");
    expect(originLink("human", "inbox: x", '(From the inbox document "2026-11-19-youtube"; bot)').url).toBe("/inbox");
    expect(originLink("scout", "insider: ACME CEO buys").url).toBe("/filings");
  });
});
