import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderReply } from "@/app/chat/render";

const tk = (sym: string, label = sym) => `<a class="ticker accent" href="/api/chart/${sym}" target="_blank" rel="noreferrer">${label}</a>`;
const html = (s: string) => renderToStaticMarkup(createElement(Fragment, null, renderReply(s, new Set(["MSTR", "MU", "RKT", "LDI", "AAON", "KNX", "STWD", "AI", "A"]))));

describe("chat reply formatting", () => {
  it("headings, bullets, bold, card links and coloured tickers", () => {
    const out = html(`**Macro read: rates moved**\n- Cards #75 (LDI) and #107 (RKT/LDI) list "10-year above 4.95%".\n- **Short MSTR** into the MSCI review; FOMC on Dec 9.\n\nIf you want just one: **AAON short** is the most independent; $XYZ too.`);
    expect(out).toContain("<h4>Macro read: rates moved</h4>");
    expect(out).toContain(`<ul><li>Cards <a href="/cards/75">#75</a> (${tk("LDI")}) and <a href="/cards/107">#107</a> (${tk("RKT")}/${tk("LDI")})`);
    expect(out).toContain(`<li><b>Short ${tk("MSTR")}</b> into the MSCI review; FOMC on Dec 9.</li></ul>`);
    expect(out).toContain(`<p>If you want just one: <b>${tk("AAON")} short</b> is the most independent; ${tk("XYZ", "$XYZ")} too.</p>`);
  });

  it("acronyms and one-letter words stay plain unless written as $X", () => {
    const out = html("A rebound in AI names; buy $A?");
    expect(out).toBe(`<p>A rebound in AI names; buy ${tk("A", "$A")}?</p>`);
  });

  it("numbered lists keep counting, with their bullets nested", () => {
    expect(html("1. First `x`\n2. Second")).toBe('<ol><li value="1">First <code>x</code></li><li value="2">Second</li></ol>');
    expect(html("1. **Long KNX**\n- Thesis: rates\n- Check: PPI\n\n2. **Short AAON**\n- Thesis: restatement")).toBe(
      `<ol><li value="1"><b>Long ${tk("KNX")}</b><ul><li>Thesis: rates</li><li>Check: PPI</li></ul></li><li value="2"><b>Short ${tk("AAON")}</b><ul><li>Thesis: restatement</li></ul></li></ol>`);
  });
});

describe("tickers in replies link to TradingView and to the scout's card", () => {
  it("links every known ticker, adds the newest card once per stock, and leaves abbreviations alone", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement, Fragment } = await import("react");
    const html = renderToStaticMarkup(createElement(Fragment, null, renderReply("Short FSK and PSEC; long ARCC. FSK again. A UBS ETN trades below NAV.", new Set(["FSK", "PSEC", "ARCC", "ETN"]), new Map([["FSK", 152]]))));
    expect(html).toContain('href="/api/chart/FSK"');
    expect(html).toContain('href="/api/chart/ARCC"');
    expect(html.match(/card #152/g)).toHaveLength(1); // once per reply
    expect(html).toContain('href="/cards/152"');
    expect(html).not.toContain("/api/chart/ETN"); // "ETN" here means an exchange-traded note
  });
});

describe("ticker links open the right listing", () => {
  it("adds the US exchange so TradingView does not open a foreign stock", async () => {
    const { tradingViewUrl, chartUrl } = await import("@/config/links");
    expect(chartUrl("$arcc")).toBe("/api/chart/ARCC");
    expect(tradingViewUrl("ARCC", "NASDAQ")).toBe("https://www.tradingview.com/chart/WBvg0COi/?symbol=NASDAQ%3AARCC");
    expect(tradingViewUrl("SPY", "ARCA")).toBe("https://www.tradingview.com/chart/WBvg0COi/?symbol=AMEX%3ASPY");
    expect(tradingViewUrl("XYZ", null)).toBe("https://www.tradingview.com/chart/WBvg0COi/?symbol=XYZ");
  });
});
