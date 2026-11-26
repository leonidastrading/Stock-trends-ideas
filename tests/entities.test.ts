import { describe, expect, it } from "vitest";
import { decodeEntities } from "@/lib/entities";

describe("HTML entities", () => {
  it("decodes named, numeric and twice-encoded entities", () => {
    expect(decodeEntities("Trump&#39;s plan &amp; AT&amp;T")).toBe("Trump's plan & AT&T");
    expect(decodeEntities("Moody&#8217;s &mdash; &ldquo;stable&rdquo; &#x2019;")).toBe("Moody’s — “stable” ’");
    expect(decodeEntities("Dick&amp;#39;s &amp;amp; Kohl&amp;rsquo;s")).toBe("Dick's & Kohl’s");
    expect(decodeEntities("R&D spend; AT&T; &unknown; &#0;")).toBe("R&D spend; AT&T; &unknown; &#0;");
  });
});
