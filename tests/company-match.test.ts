import { describe, expect, it } from "vitest";
import { cleanNewsSymbols, coreName, listingOf, looksForeign, mentionsCompany, mentionsDrug, qualifiedSymbols, unitWarrantRight } from "@/lib/scout/company-match";

describe("the company's name, without legal forms and listing words", () => {
  it("cuts listing boilerplate and legal forms", () => {
    expect(coreName("TransMedics Group, Inc.")).toEqual(["transmedics"]);
    expect(coreName("Sea Limited American Depositary Shares, each representing one Class A Ordinary Share")).toEqual(["sea"]);
    expect(coreName("American Airlines Group Inc. Common Stock")).toEqual(["american", "airlines"]);
    expect(coreName("JD.com, Inc. American Depositary Shares")).toEqual(["jd", "com"]);
    expect(coreName("Quest Diagnostics Incorporated")).toEqual(["quest", "diagnostics"]);
    expect(coreName("The Coca-Cola Company")).toEqual(["coca", "cola"]);
  });
});

describe("does a text name a company?", () => {
  const mife = "Requests that the FDA restore the in-person dispensing requirement for mifepristone. Petitioner: American College of Pro-Life Obstetricians and Gynecologists";
  it("is not fooled by one shared word (the mifepristone petition)", () => {
    for (const name of ["Sea Limited American Depositary Shares", "JD.com, Inc. American Depositary Shares", "Oatly Group AB American Depositary Shares", "Sony Group Corporation American Depositary Shares", "American Airlines Group Inc.", "Pony AI Inc. American Depositary Shares", "Arm Holdings plc American Depositary Shares", "Embraer S.A. American Depositary Shares"])
      expect(mentionsCompany(mife, name), name).toBe(false);
  });
  it("is not fooled by 'Resources', 'Quest' or 'United' either", () => {
    const t = "Requests that FDA refuse to approve any cancer drug application that relies on overseas resources; a quest for better united standards";
    for (const name of ["Targa Resources Corp.", "Comstock Resources, Inc.", "Quest Diagnostics Incorporated", "United Airlines Holdings, Inc.", "United States Oil Fund, LP"]) expect(mentionsCompany(t, name), name).toBe(false);
  });
  it("matches a company the text does name", () => {
    expect(mentionsCompany("Requests that FDA withdraw approval of TransMedics' Organ Care System", "TransMedics Group, Inc.")).toBe(true);
    expect(mentionsCompany("Scorpion Capital asks FDA to act on HARMONY BIOSCIENCES' Wakix", "Harmony Biosciences Holdings, Inc.")).toBe(true);
    expect(mentionsCompany("a petition about Quest Diagnostics' test", "Quest Diagnostics Incorporated")).toBe(true);
    expect(mentionsCompany("American Airlines asked the agency", "American Airlines Group Inc.")).toBe(true);
    expect(mentionsCompany("Arm Holdings said", "Arm Holdings plc American Depositary Shares")).toBe(true);
    expect(mentionsCompany("a shot in the arm for the sector", "Arm Holdings plc American Depositary Shares")).toBe(false);
    expect(mentionsCompany("Pfizer's request", "Pfizer Inc.")).toBe(true);
    expect(mentionsCompany("the oatly brand, in lower case", "Oatly Group AB")).toBe(false); // not written as a name
  });
  it("matches a drug by its own name, not its form or salt", () => {
    expect(mentionsDrug("restore the in-person dispensing requirement for mifepristone", "Mifepristone tablets")).toBe(true);
    expect(mentionsDrug("any sodium chloride oral solution", "Sodium oxybate oral solution")).toBe(false);
    expect(mentionsDrug("concerning Xywav (oxybate)", "Sodium oxybate oral solution")).toBe(true);
  });
});

describe("symbols given with an exchange", () => {
  it("tells US from foreign", () => {
    expect(qualifiedSymbols("Acme (NASDAQ: ACME) and Babcock (LSE: BAB), also TSX:AC and NYSE American: XYZ")).toEqual({ us: ["ACME", "XYZ"], foreign: [{ exchange: "LSE", symbol: "BAB" }, { exchange: "TSX", symbol: "AC" }] });
    expect(qualifiedSymbols("THE BABCOCK PLAN: A NOTE")).toEqual({ us: [], foreign: [] });
  });
});

describe("a news item's tags", () => {
  const names: Record<string, string> = { BAB: "Invesco Taxable Municipal Bond ETF", KEYS: "Keysight Technologies, Inc.", AON: "Aon plc Class A Ordinary Shares", NVDA: "NVIDIA Corporation", SPI: "SPI Energy Co., Ltd." };
  const nameOf = (s: string) => names[s] ?? null;
  it("takes a London listing off the US symbol with the same letters", () => {
    expect(cleanNewsSymbols({ headline: "Babcock International Group PLC: Holding(s) in Company", symbols: ["BAB"] }, nameOf)).toEqual({ symbols: [], foreign: ["BAB"] });
    expect(cleanNewsSymbols({ headline: "Keystone Law Group (LSE: KEYS) Trading Statement", symbols: ["KEYS"] }, nameOf)).toEqual({ symbols: [], foreign: ["LSE: KEYS"] });
    expect(cleanNewsSymbols({ headline: "Spire Healthcare Group plc - Director/PDMR Shareholding", symbols: ["SPI"] }, nameOf)).toEqual({ symbols: [], foreign: ["SPI"] });
  });
  it("keeps a US-listed PLC and ordinary US news", () => {
    expect(cleanNewsSymbols({ headline: "Aon plc Reports Third Quarter Results", symbols: ["AON"] }, nameOf).symbols).toEqual(["AON"]);
    expect(cleanNewsSymbols({ headline: "Why Nvidia stock is up today", symbols: ["NVDA"] }, nameOf).symbols).toEqual(["NVDA"]);
    expect(cleanNewsSymbols({ headline: "Acme plc (NYSE: ACME) completes listing", symbols: ["ACME"] }, nameOf).symbols).toEqual(["ACME"]);
    expect(looksForeign("Nvidia beats estimates")).toBe(false);
  });
});

describe("what a Stocktwits symbol is", () => {
  it("keeps a foreign listing with its exchange", () => {
    expect(listingOf("AC.TSX")).toEqual({ kind: "foreign", symbol: "AC.TSX", exchange: "TSX", tv: "TSX:AC" });
    expect(listingOf("005930.KRX")).toMatchObject({ kind: "foreign", tv: "KRX:005930" });
    expect(listingOf("SHOP.CA")).toMatchObject({ kind: "foreign", tv: "TSX:SHOP" });
  });
  it("knows US share classes, crypto and currencies", () => {
    expect(listingOf("BRK.B").kind).toBe("us");
    expect(listingOf("HUBS", "NASDAQ").kind).toBe("us");
    expect(listingOf("BTC.X")).toMatchObject({ kind: "crypto", tv: "COINBASE:BTCUSD" });
    expect(listingOf("EURUSD", "FX")).toMatchObject({ kind: "currency", tv: "FX:EURUSD" });
    expect(listingOf("XAUUSD")).toMatchObject({ kind: "currency", tv: "OANDA:XAUUSD" });
  });
});

describe("units, warrants and rights", () => {
  it("reads them from the security's name, or the symbol when there is none", () => {
    expect(unitWarrantRight("ABCDU", "Alpha Beta Acquisition Corp. Units, each consisting of one share and one warrant")).toBe("unit");
    expect(unitWarrantRight("ABCDW", "Alpha Beta Acquisition Corp. Warrant")).toBe("warrant");
    expect(unitWarrantRight("ABCD.U")).toBe("unit");
    expect(unitWarrantRight("ABCDU")).toBe("unit");
    expect(unitWarrantRight("BIDU", "Baidu, Inc. American Depositary Shares")).toBeNull();
    expect(unitWarrantRight("NVDA", "NVIDIA Corporation Common Stock")).toBeNull();
    expect(unitWarrantRight("XPEVR", "Some Real Company Inc")).toBeNull(); // named, and not a right
  });
});

import { cleanNewsItems } from "@/lib/scout/news-symbols";

describe("the news feed's tags", () => {
  const names = new Map([["BAB", "Invesco Taxable Municipal Bond ETF"], ["AON", "Aon plc"], ["FAN", "First Trust Global Wind Energy ETF"]]);
  it("takes Babcock off the US fund BAB and says where it is listed", () => {
    const [n] = cleanNewsItems([{ headline: "Babcock International Group PLC - Holding(s) in Company", summary: "", symbols: ["BAB"] }], names);
    expect(n.symbols).toEqual([]);
    expect(n.summary).toContain("Listed outside the US (BAB)");
  });
  it("leaves US news and US-listed PLCs alone", () => {
    const items = [{ headline: "Aon plc Reports Third Quarter Results", summary: "", symbols: ["AON"] }, { headline: "Wind stocks rally", summary: "", symbols: ["FAN"] }];
    expect(cleanNewsItems(items, names)).toEqual(items);
  });
  it("without the SEC's names, only takes off a symbol the text gives a foreign exchange for", () => {
    expect(cleanNewsItems([{ headline: "Volution Group plc Final Results", summary: "", symbols: ["FAN"] }], new Map())[0].symbols).toEqual(["FAN"]);
    expect(cleanNewsItems([{ headline: "Volution Group (LSE: FAN) Final Results", summary: "", symbols: ["FAN"] }], new Map())[0].symbols).toEqual([]);
  });
});

import { correctedTickers, renameTickerInText } from "@/lib/scout/identity";

describe("a corrected ticker in a card's text", () => {
  it("is written the new way before the card is logged", () => {
    const card = { title: "Embraer delivery slip", thesis: "Short ERJ: deliveries slip into 2027. ERJ's backlog is thin.", tickers: [{ symbol: "EMBJ", company: "Embraer" }], evidence: [{ url: "https://x/ERJ", text: "(NYSE: ERJ) said" }] };
    const out = renameTickerInText(card, "ERJ", "EMBJ");
    expect(out.thesis).toBe("Short EMBJ: deliveries slip into 2027. EMBJ's backlog is thin.");
    expect(out.evidence[0]).toEqual({ url: "https://x/ERJ", text: "(NYSE: EMBJ) said" });
  });
  it("replaces a one-letter symbol only where it is written as a ticker", () => {
    expect(renameTickerInText({ t: "Short X on a weak quarter. X marks the spot." }, "X", "USX").t).toBe("Short USX on a weak quarter. X marks the spot.");
    expect(correctedTickers(["ticker corrected ERJ → EMBJ: ERJ now trades as ...", "other"])).toEqual([{ from: "ERJ", to: "EMBJ" }]);
  });
});

import { searchableName } from "@/lib/scout/company-match";
import { labelTicker } from "@/lib/scout/probe-term";

describe("a name that can be searched for", () => {
  it("rejects one short acronym or one ordinary word", () => {
    expect(searchableName("TMS Inc. Common Stock")).toBe(false);
    expect(searchableName("Block, Inc. Class A")).toBe(false);
    expect(searchableName("Unity Software Inc.")).toBe(true);
    expect(searchableName("Texas Instruments Incorporated Common Stock")).toBe(true);
    expect(searchableName("Nutanix, Inc.")).toBe(true);
    expect(searchableName(null)).toBe(false);
  });
  it("reads the ticker out of a desk's label, and leaves stories as typed", () => {
    expect(labelTicker("insider: OPAL", ["OPAL"])).toBe("OPAL");
    expect(labelTicker("stocktwits: HUBS trending 2026-11-26", ["HUBS"])).toBe("HUBS");
    expect(labelTicker("story: Nutanix chief executive exit", ["NTNX"])).toBeNull();
    expect(labelTicker("inbox: NAND storage basket rebound", ["STX", "SNDK"])).toBeNull();
    expect(labelTicker("humanoid robots", ["TSLA"])).toBeNull();
  });
});
