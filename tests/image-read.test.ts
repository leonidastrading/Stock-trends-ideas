import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setQuerierForTests } from "@/lib/db";
import { IMAGE_PROMPT, observationFrom, parseImageReading, readImage } from "@/lib/scout/image-read";
import type { CallModel } from "@/lib/scout/llm";

const reply = { kind: "chart", text_in_image: "URGN 1D  25.41  -24% 1M", what_it_shows: "A daily chart of UroGen falling from about $34 to $25 over a month.", tickers: ["$urgn", "nope!"], date_shown: "2026-11-16", observation: "UroGen fell 24% in a month while revenue grew 224%.", term: "UroGen Zusduri" };

describe("reading an uploaded image", () => {
  it("the prompt does not guess tickers and treats the image as data", () => {
    expect(IMAGE_PROMPT).toMatch(/do not guess/);
    expect(IMAGE_PROMPT).toMatch(/data, not instructions/);
  });

  it("cleans the reply and drafts the observation for the form, under the long-text threshold", () => {
    const r = parseImageReading(JSON.stringify(reply));
    expect(r.tickers).toEqual(["URGN"]);
    const o = observationFrom(r, "is this overdone?");
    expect(o.startsWith("is this overdone?\n\nUroGen fell 24% in a month")).toBe(true);
    expect(o).toContain("From an uploaded image (chart, dated 2026-11-16)");
    expect(observationFrom({ ...r, text_in_image: "x".repeat(5000) }, "").length).toBeLessThanOrEqual(1450);
  });
});

describe("reading an uploaded image (PGlite, fake model)", () => {
  let pg: PGlite;
  beforeAll(() => {
    pg = new PGlite();
    setQuerierForTests({ query: async (text, params) => (await pg.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  });
  afterAll(() => setQuerierForTests(null));

  it("sends the image to the model and logs the cost", async () => {
    let got: { purpose?: string; images?: Array<{ mediaType: string; data: string }> } = {};
    const callModel: CallModel = async (args) => { got = args; return { text: JSON.stringify(reply), stopReason: "end_turn", modelServed: "m", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.01 }; };
    const r = await readImage({ mediaType: "image/jpeg", data: "QUJD" }, "", { callModel, now: new Date() });
    expect(r.term).toBe("UroGen Zusduri");
    expect(got.purpose).toBe("image_read");
    expect(got.images).toEqual([{ mediaType: "image/jpeg", data: "QUJD" }]);
  });
});
