import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { joinParts, kindOf, looksBinary, officeText, unzipFiles } from "@/lib/files/unpack";
import { imageAsText, partText } from "@/lib/scout/rumors";

describe("uploads for the Rumors box", () => {
  it("knows each file kind", () => {
    expect(["a.zip", "b.PDF", "c.docx", "d.jpeg", "e.HEIC", "f.json", "g.html", "notes", "h.exe"].map((n) => kindOf(n))).toEqual(["zip", "pdf", "office", "image", "image", "text", "text", "text", "skip"]);
    expect(kindOf("x", "image/png")).toBe("image");
    expect(looksBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(looksBinary(strToU8("plain text"))).toBe(false);
  });

  it("opens a zip, nested zips and folders, and skips system junk", () => {
    const inner = zipSync({ "deep.txt": strToU8("deep claim") });
    const zip = zipSync({ "posts/a.txt": strToU8("claim A"), "__MACOSX/posts/._a.txt": strToU8("junk"), ".DS_Store": strToU8("junk"), "more.zip": inner, "pic.png": new Uint8Array([137, 80, 78, 71]) });
    const { files, skipped } = unzipFiles(zip, "dump.zip/");
    expect(files.map((f) => f.name).sort()).toEqual(["dump.zip/more.zip/deep.txt", "dump.zip/pic.png", "dump.zip/posts/a.txt"]);
    expect(skipped).toEqual([]);
    expect(unzipFiles(strToU8("not a zip")).skipped[0]).toMatch(/could not open/);
  });

  it("reads Word, PowerPoint and Excel text", () => {
    const docx = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Insiders at ACME</w:t></w:r></w:p><w:p><w:r><w:t>are selling &amp; leaving</w:t></w:r></w:p></w:body></w:document>'), "word/styles.xml": strToU8("<x>style</x>") });
    expect(officeText("a.docx", docx)).toBe("Insiders at ACME\nare selling & leaving");
    const pptx = zipSync({ "ppt/slides/slide2.xml": strToU8("<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>"), "ppt/slides/slide10.xml": strToU8("<a:p><a:t>Tenth</a:t></a:p>"), "ppt/slides/slide1.xml": strToU8("<a:p><a:t>First</a:t></a:p>") });
    expect(officeText("a.pptx", pptx)).toBe("[Slide 1]\nFirst\n\n[Slide 2]\nSecond\n\n[Slide 10]\nTenth");
    const xlsx = zipSync({ "xl/sharedStrings.xml": strToU8("<sst><si><t>ticker</t></si><si><t>XYZ</t></si></sst>") });
    expect(officeText("a.xlsx", xlsx)).toBe("ticker\nXYZ");
    expect(officeText("a.docx", strToU8("broken"))).toBe("");
  });

  it("joins pieces with a header each, and leaves a single piece as it is", () => {
    expect(joinParts([{ name: "a.json", text: '{"x":1}' }])).toBe('{"x":1}');
    expect(joinParts([{ name: "a.txt", text: "one" }, { name: "b.txt", text: " " }, { name: "c.png", text: "two" }])).toBe("===== a.txt =====\none\n\n===== c.png =====\ntwo");
    expect(joinParts([{ name: "a", text: "x".repeat(50) }, { name: "b", text: "y" }], 20)).toHaveLength(20);
  });

  it("turns each JSON dump into posts before joining, and an image reading into text", async () => {
    const t = await partText(JSON.stringify({ data: { children: [{ data: { subreddit_name_prefixed: "r/x", title: "ACME is a fraud", selftext: "the CFO quit" } }] } }));
    expect(t).toMatch(/ACME is a fraud/);
    expect(t).not.toMatch(/children/);
    expect(imageAsText({ kind: "post", what_it_shows: "A tweet about ACME.", text_in_image: "ACME halted", tickers: ["ACME"], date_shown: "2026-11-19" })).toBe("[post, dated 2026-11-19] A tweet about ACME.\nText in it: ACME halted\nTickers shown: ACME");
  });
});
