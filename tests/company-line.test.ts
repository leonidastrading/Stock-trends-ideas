import { describe, expect, it } from "vitest";
import { firstSentences, industryLabel, isStale } from "../lib/scout/company-line";
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
    const a = (daysAgo: number, about: string | null) => ({ symbol: "X", at: new Date(now.getTime() - daysAgo * 86400_000).toISOString(), about, article: null, industry: null });
    expect(isStale(null, now)).toBe(true);
    expect(isStale(a(10, "Makes things."), now)).toBe(false);
    expect(isStale(a(50, "Makes things."), now)).toBe(true);
    expect(isStale(a(2, null), now)).toBe(false);
    expect(isStale(a(4, null), now)).toBe(true);
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
