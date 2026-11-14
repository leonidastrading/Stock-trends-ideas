import { describe, expect, it } from "vitest";
import { importObservation, importTerm, parseImport } from "@/lib/scout/importer";

describe("daily file import", () => {
  it("parses the block as pasted from the PDF, with line wraps inside strings and a code fence", () => {
    const pasted = '```json\n[\n  {"observation": "Zoom carries its Anthropic stake at $3.13B (Jul 31), about 11% of its market\ncap.", "term": "zoom anthropic stake\nipo", "kind": "event", "tickers": ["ZM"], "direction": "long", "catalyst_date": "2026-11-18", "source": "host", "confirmed": "partly", "stream_time": "0:24"},\n  {"observation": "x", "term": "bad"}\n]\n```';
    const { items, errors } = parseImport(pasted);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ term: "zoom anthropic stake ipo", kind: "event", source: "host", tickers: ["ZM"] });
    expect(errors[0]).toMatch(/item 2: observation/);
    expect(importTerm(items[0])).toBe("stream host: zoom anthropic stake ipo");
    expect(importObservation(items[0], "2026-11-13")).toMatch(/From the 2026-11-13 daily stream file; the stream host's idea; proposed direction: long; catalyst date: 2026-11-18/);
    expect(parseImport("nothing here").errors[0]).toMatch(/no JSON array/);
  });
});
