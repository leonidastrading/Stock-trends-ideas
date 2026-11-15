import { describe, expect, it } from "vitest";
import { smartMoneySignals } from "@/lib/scout/filings";
import { playerOf } from "@/lib/scout/scoreboard";
import type { CongressTradeRow, InsiderBuyRow } from "@/lib/scout/store";
import { parseSenatePtr, parseSenateSearch, SenateSession } from "@/lib/sources/senate";

// A row as efdsearch.senate.gov serves it (Capito, report for 11/04/2026), plus a bond and an option row.
const row = (n: number, date: string, owner: string, ticker: string, asset: string, type: string, tx: string, amount: string) => `<tr>
  <td>${n}</td>
  <td>
      ${date}
  </td>
  <td>${owner}</td>
  <td>
      ${ticker === "--" ? "--" : `<a href="https://finance.yahoo.com/quote/${ticker}"
         target="_blank">${ticker}</a>`}
  </td>
  <td>
      ${asset}
  </td>
  <td>${type}</td>
  <td>${tx}</td>

  <td>${amount}</td>
  <td>--</td>
</tr>`;
const PTR = `<html><body><h1>Periodic Transaction Report for 11/04/2026</h1><table class="table"><thead><tr><th>#</th></tr></thead><tbody>
${row(4, "10/21/2026", "Spouse", "ZTS", "Zoetis Inc. Class A Common Stock", "Stock", "Sale (Full)", "$1,001 - $15,000")}
${row(3, "10/21/2026", "Self", "NVDA", "NVIDIA Corp", "Stock Option", "Purchase", "$15,001 - $50,000")}
${row(2, "10/20/2026", "Joint", "--", "US Treasury Note 4%", "Government Security", "Purchase", "$50,001 - $100,000")}
${row(1, "10/19/2026", "Spouse", "AAPL", "Apple Inc. - Common Stock", "Stock", "Sale (Partial)", "$1,001 - $15,000")}
</tbody></table></body></html>`;

describe("Senate disclosures", () => {
  it("reads the search rows (electronic reports only) and the report table", () => {
    const s = parseSenateSearch({ data: [
      ["Shelley M", "Capito", "Capito, Shelley Moore (Senator)", "<a href=\"/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/\" target=\"_blank\">Periodic Transaction Report for 11/04/2026</a>", "11/04/2026"],
      ["Some", "Senator", "Senator, Some", "<a href=\"/search/view/paper/0b0d3c7e-0000-0000-0000-000000000000/\">Periodic Transaction Report</a>", "11/03/2026"],
    ] });
    expect(s).toEqual({ rows: 2, reports: [{ docId: "a89c0c6b-4c12-4955-98f9-3a54ca52d8a3", member: "Shelley M Capito", filed: "2026-11-04" }] });
    expect(parseSenatePtr(PTR, "2026-11-04").map((t) => [t.symbol, t.owner, t.tx, t.assetType, t.txDate, t.notified, t.amountLow])).toEqual([
      ["ZTS", "spouse", "sell", "stock", "2026-10-21", "2026-11-04", 1001],
      ["NVDA", "self", "buy", "option", "2026-10-21", "2026-11-04", 15001],
      ["AAPL", "spouse", "partial sale", "stock", "2026-10-19", "2026-11-04", 1001],
    ]);
  });

  it("accepts the terms with the form's token, then searches with the cookie's token", async () => {
    const seen: Array<{ url: string; method: string; cookie: string; csrf: string | null; body: string }> = [];
    const res = (body: string, status = 200, cookies: string[] = []) => { const h = new Headers({ "content-type": "text/html" }); for (const c of cookies) h.append("set-cookie", c); return new Response(body, { status, headers: h }); };
    const fake = (async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers);
      seen.push({ url: String(url), method: init.method ?? "GET", cookie: h.get("cookie") ?? "", csrf: h.get("x-csrftoken"), body: String(init.body ?? "") });
      if (String(url).endsWith("/search/home/") && !init.method) return res('<form><input type="hidden" name="csrfmiddlewaretoken" value="FORMTOKEN"></form>', 200, ["csrftoken=COOKIETOKEN; Path=/; SameSite=Lax"]);
      if (String(url).endsWith("/search/home/")) return res("", 302, ["sessionid=S1; Path=/; HttpOnly"]);
      if (String(url).endsWith("/search/report/data/")) return new Response(JSON.stringify({ data: [["Shelley M", "Capito", "x", "<a href=\"/search/view/ptr/a89c0c6b-4c12-4955-98f9-3a54ca52d8a3/\">r</a>", "11/04/2026"]] }), { status: 200 });
      return res(PTR);
    }) as unknown as typeof fetch;
    const s = new SenateSession(fake);
    await s.open();
    const reports = await s.reports("2026-09-16");
    expect(reports).toHaveLength(1);
    expect(await s.report(reports[0].docId)).toContain("Zoetis");
    expect(seen[1].body).toBe("prohibition_agreement=1&csrfmiddlewaretoken=FORMTOKEN");
    expect(seen[2]).toMatchObject({ method: "POST", csrf: "COOKIETOKEN" });
    expect(seen[2].cookie).toBe("csrftoken=COOKIETOKEN; sessionid=S1");
    expect(seen[2].body).toMatch(/report_types=%5B11%5D/);
    expect(seen[2].body).toMatch(/submitted_start_date=09%2F16%2F2026\+00%3A00%3A00/);
  });
});

const T = (o: Partial<CongressTradeRow>): CongressTradeRow => ({ docId: "1", ord: 0, chamber: "House", member: "A", stateDst: null, filed: "2026-11-12", owner: "self", symbol: "MU", assetType: "stock", tx: "buy", txDate: "2026-10-20", notified: null, amountLow: 15001, amountHigh: 50000, amount: "$15,001 - $50,000", ...o });
const B = (o: Partial<InsiderBuyRow>): InsiderBuyRow => ({ accession: "x", filed: "2026-11-10", issuerCik: null, symbol: "MU", issuerName: "Micron", owner: "CEO Person", ownerCik: null, role: "CEO", txDate: "2026-11-06", shares: 1000, price: 100, value: 100_000, ownedAfter: null, pctIncrease: 12, plan10b5: false, routine: false, ...o });

describe("insiders + Congress signals for research", () => {
  it("insiders and Congress buying the same stock is the strongest; Congress clusters stand alone; stale or routine ones do not count", () => {
    const s = smartMoneySignals(
      [B({}), B({ symbol: "WMT", routine: true }), B({ symbol: "AVGO", filed: "2026-08-01" })],
      [T({}), T({ symbol: "WMT", member: "B" }), T({ symbol: "AVGO", member: "C" }),
        T({ symbol: "LMT", member: "D" }), T({ symbol: "LMT", member: "E", chamber: "Senate" }), T({ symbol: "LMT", member: "F" }),
        T({ symbol: "OLD", member: "G", filed: "2026-10-01" }), T({ symbol: "OLD", member: "H", filed: "2026-10-01" }), T({ symbol: "OLD", member: "I", filed: "2026-10-01" })],
      "2026-11-15",
    );
    expect(s.map((x) => [x.kind, x.symbol, x.strength])).toEqual([["insider+congress", "MU", 3.5], ["congress", "LMT", 2.5]]);
    expect(s[0].context).toMatch(/CEO Person \(CEO\) bought \$100k on 2026-11-06, \+12% to their holding, outside their usual trading month/);
    expect(s[0].context).toMatch(/A \(House\) bought MU \$15,001 - \$50,000 on 2026-10-20, reported 2026-11-12/);
    expect(s[1].context).toMatch(/E \(Senate\) bought LMT/);
  });

  it("their cards score as their own player", () => {
    expect(playerOf("scout", "insider+congress: MU")).toBe("scout_filings");
    expect(playerOf("scout", "congress: LMT")).toBe("scout_filings");
    expect(playerOf("scout", "insider: MU")).toBe("scout_filings");
    expect(playerOf("scout", "story: NVDA")).toBe("scout_story");
  });
});

describe("insider buy strength", () => {
  it("a single huge purchase ranks with clustered buying, not last", async () => {
    const { insiderStrength, pickSignals } = await import("@/lib/scout/filings");
    expect(insiderStrength(1, [B({ value: 14_700_000, pctIncrease: 491, routine: false })])).toBe(3); // STWD: ahead of new 13Ds (2)
    expect(insiderStrength(1, [B({ value: 9_200_000, pctIncrease: null, routine: null })])).toBe(2.5);
    expect(insiderStrength(1, [B({ value: 1_000_000, pctIncrease: 4, routine: false })])).toBe(2);
    expect(insiderStrength(1, [B({ value: 60_000, pctIncrease: 5, routine: true })])).toBe(1);
    expect(insiderStrength(3, [B({ value: 5_000_000, pctIncrease: 80, routine: false })])).toBe(3.4);
    // A $9.2M director purchase with an unknown holding now qualifies on size alone.
    const s = pickSignals([B({ symbol: "FUN", value: 9_200_000, pctIncrease: null, routine: null, filed: "2026-11-13" })], [], "2026-11-15");
    expect(s.map((x) => [x.symbol, x.strength])).toEqual([["FUN", 2.5]]);
  });
});
