import { describe, expect, it } from "vitest";
import { docLabel, withDocument } from "../lib/scout/research-doc";

describe("documents uploaded on the Research tab", () => {
  it("attaches the document after the idea, marked as material rather than instructions", () => {
    const o = withDocument("  Is ORCL's backlog real?  ", "oracle-10q.pdf", "Remaining performance obligations were $455 billion.\n\n\n\nCapex rose.");
    expect(o.startsWith("Is ORCL's backlog real?\n\n")).toBe(true);
    expect(o).toContain('"oracle-10q.pdf"');
    expect(o).toContain("not instructions");
    expect(o).toContain("Remaining performance obligations were $455 billion.\n\nCapex rose.");
    expect(o.endsWith("----- end of document -----")).toBe(true);
  });

  it("cuts a long document and says how much was kept", () => {
    const o = withDocument("Idea", "big.txt", "x".repeat(50_000), 1000);
    expect(o).toContain("the first 1,000 of 50,000 characters");
    expect(o.match(/x+/g)!.sort((a, b) => b.length - a.length)[0].length).toBe(1000);
  });

  it("leaves the idea alone when the document has no text", () => {
    expect(withDocument("Idea", "empty.pdf", "  \n ")).toBe("Idea");
  });

  it("names what was uploaded", () => {
    expect(docLabel(["a.pdf"])).toBe("a.pdf");
    expect(docLabel(["a.pdf", "b.docx", "c.png"])).toBe("a.pdf and 2 more");
    expect(docLabel([])).toBe("");
  });
});
