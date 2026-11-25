import { describe, expect, it } from "vitest";
import { firstSentences, industryLabel, industryToShow, isStale, saysNothing } from "../lib/scout/company-line";
import { thesisFor, tidyThesis } from "../lib/scout/thesis";

describe("one line on what a company does", () => {
  it("takes the opening of the article, whole sentences, without the asides", () => {
    expect(firstSentences("Plexus Corp. (Nasdaq: PLXS) is an American multinational corporation that provides electronics design, manufacturing and aftermarket services. It is headquartered in Neenah, Wisconsin. The company was founded in 1979."))
      .toBe("Plexus Corp. is an American multinational corporation that provides electronics design, manufacturing and aftermarket services.");
    expect(firstSentences("Ashland Inc. is an American chemical company. It operates in more than 100 countries. It was founded in 1924 in Kentucky by Paul Blazer.")).toBe("Ashland Inc. is an American chemical company. It operates in more than 100 countries.");
    expect(firstSentences("")).toBeNull();
    expect(firstSentences("Short.")).toBeNull();
    const long = firstSentences(`Acme is a company that ${"makes many different things and ".repeat(20)}more.`)!;
    expect(long.length).toBeLessThanOrEqual(231);
    expect(long.endsWith("…")).toBe(true);
  });
  it("puts the SEC's industry in ordinary case", () => {
    expect(industryLabel("PRINTED CIRCUIT BOARDS")).toBe("Printed circuit boards");
    expect(industryLabel("SERVICES-BUSINESS SERVICES, NEC")).toBe("Services-business services, NEC");
    expect(industryLabel("")).toBeNull();
    expect(industryLabel(null)).toBeNull();
  });
  it("looks a stock up again after 45 days, or after 3 when nothing was found", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const a = (daysAgo: number, about: string | null) => ({ symbol: "X", at: new Date(now.getTime() - daysAgo * 86400_000).toISOString(), about, article: null, industry: null, rev: 3 });
    // A line written by an older version of the lookup (Redwire's, with an industry but no description) is done again at once.
    expect(isStale({ ...a(0, null), rev: undefined }, now)).toBe(true);
    expect(isStale({ ...a(0, "Makes things."), rev: 1 }, now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
    expect(isStale(a(10, "Makes things."), now)).toBe(false);
    expect(isStale(a(50, "Makes things."), now)).toBe(true);
    expect(isStale(a(2, null), now)).toBe(false);
    expect(isStale(a(4, null), now)).toBe(true);
    // An industry label alone is not a description: it is tried again too.
    expect(isStale({ ...a(4, null), industry: "Aerospace & Defense" }, now)).toBe(true);
  });
});

describe("the line says what the company does, not where it is", () => {
  it("skips an opening that only places the company (CytoSorbents' article)", () => {
    const extract = "CytoSorbents Corporation is a publicly traded company located in Princeton, New Jersey. The company develops blood purification technology that removes toxic substances from blood using polymer beads. Its main product is CytoSorb.";
    expect(firstSentences(extract)).toBe("The company develops blood purification technology that removes toxic substances from blood using polymer beads. Its main product is CytoSorb.");
    for (const t of ["CytoSorbents Corporation is a publicly traded company located in Princeton, New Jersey.", "Acme Corp. is an American company headquartered in Austin, Texas.", "Widget Holdings is a public company.", "Foo Inc. is a Delaware-based corporation founded in 1999."]) expect(saysNothing(t), t).toBe(true);
    for (const t of ["Plexus Corp. is an American multinational corporation that provides electronics design, manufacturing and aftermarket services.", "Ashland Inc. is an American chemical company.", "Redwire Corporation is an American aerospace manufacturer and space infrastructure technology company headquartered in Jacksonville, Florida.", "The company develops blood purification technology."]) expect(saysNothing(t), t).toBe(false);
    // Nothing but the placing sentence: no line at all (the data vendor's description is tried instead).
    expect(firstSentences("CytoSorbents Corporation is a publicly traded company located in Princeton, New Jersey.")).toBeNull();
  });
  it("shows an industry only when it adds something to the sector", () => {
    expect(industryToShow("Health care", "Health Care", "Surgical & medical instruments & apparatus")).toBe("Surgical & medical instruments & apparatus");
    expect(industryToShow("Health care", "Health Care", null)).toBeNull();
    expect(industryToShow("Industrials", "Aerospace & Defense", "Guided missiles & space vehicles & parts")).toBe("Aerospace & Defense");
    expect(industryToShow("Technology", "Technology", "Technology")).toBeNull();
    expect(industryToShow("Financials", null, null)).toBeNull();
  });
});

describe("a one-sided thesis is shown as one side", () => {
  it("drops the empty half some cards open with (cards #391 and #394)", () => {
    expect(tidyThesis("Long nothing; Short PLXS: after an officer or director departure filing knocked the stock down about 10%, it could fall further.")).toBe("Short PLXS: after an officer or director departure filing knocked the stock down about 10%, it could fall further.");
    expect(tidyThesis("Long nothing, Short ASH: with Evonik walking away, the premium could leak out.")).toBe("Short ASH: with Evonik walking away, the premium could leak out.");
    expect(tidyThesis("Short nothing; long GPN: a buyer is circling.")).toBe("Long GPN: a buyer is circling.");
    expect(tidyThesis("Long GPN: a buyer is circling.")).toBe("Long GPN: a buyer is circling.");
    // A real pair is left alone.
    expect(tidyThesis("Long HPQ, short DELL: memory costs hit one more than the other.")).toBe("Long HPQ, short DELL: memory costs hit one more than the other.");
    expect(thesisFor({ direction: "short", primaryTicker: "PLXS", card: { thesis: "Long nothing; Short PLXS: it should lag." } as never })).toBe("Short PLXS: it should lag.");
  });
});
