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
