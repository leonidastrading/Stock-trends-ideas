import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderReply } from "@/app/chat/render";

const html = (s: string) => renderToStaticMarkup(createElement(Fragment, null, renderReply(s, new Set(["MSTR", "MU", "RKT", "LDI", "AAON", "KNX", "STWD", "AI", "A"]))));

describe("chat reply formatting", () => {
  it("headings, bullets, bold, card links and coloured tickers", () => {
    const out = html(`**Macro read: rates moved**\n- Cards #75 (LDI) and #107 (RKT/LDI) list "10-year above 4.95%".\n- **Short MSTR** into the MSCI review; FOMC on Dec 9.\n\nIf you want just one: **AAON short** is the most independent; $XYZ too.`);
    expect(out).toContain("<h4>Macro read: rates moved</h4>");
    expect(out).toContain('<ul><li>Cards <a href="/candidates?days=365&amp;card=75#card-75">#75</a> (<b class="accent">LDI</b>) and <a href="/candidates?days=365&amp;card=107#card-107">#107</a> (<b class="accent">RKT</b>/<b class="accent">LDI</b>)');
    expect(out).toContain('<li><b>Short <b class="accent">MSTR</b></b> into the MSCI review; FOMC on Dec 9.</li></ul>');
    expect(out).toContain('<p>If you want just one: <b><b class="accent">AAON</b> short</b> is the most independent; <b class="accent">$XYZ</b> too.</p>');
  });

  it("acronyms and one-letter words stay plain unless written as $X", () => {
    const out = html("A rebound in AI names; buy $A?");
    expect(out).toBe('<p>A rebound in AI names; buy <b class="accent">$A</b>?</p>');
  });

  it("numbered lists keep counting, with their bullets nested", () => {
    expect(html("1. First `x`\n2. Second")).toBe('<ol><li value="1">First <code>x</code></li><li value="2">Second</li></ol>');
    expect(html("1. **Long KNX**\n- Thesis: rates\n- Check: PPI\n\n2. **Short AAON**\n- Thesis: restatement")).toBe(
      '<ol><li value="1"><b>Long <b class="accent">KNX</b></b><ul><li>Thesis: rates</li><li>Check: PPI</li></ul></li><li value="2"><b>Short <b class="accent">AAON</b></b><ul><li>Thesis: restatement</li></ul></li></ol>');
  });
});
