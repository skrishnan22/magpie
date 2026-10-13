import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunk";

const sentence = "Magpies collect shiny objects and hide them in carefully chosen places. ";

function longDoc(sections: number, parasPerSection: number): string {
  const out: string[] = [];
  for (let s = 1; s <= sections; s++) {
    out.push(`## Part ${s}`);
    for (let p = 1; p <= parasPerSection; p++) out.push(`section ${s} paragraph ${p} ${sentence.repeat(4)}`.trim());
  }
  return out.join("\n\n");
}

const bodyOf = (chunkText: string) => chunkText.slice(chunkText.indexOf("\n\n") + 2);

describe("chunkMarkdown", () => {
  it("keeps a short document as one chunk prefixed with its title", () => {
    expect(chunkMarkdown("hello world", "My Title")).toEqual([
      { idx: 0, heading: null, text: "My Title\n\nhello world" },
    ]);
  });

  it("splits long documents into bounded, overlapping chunks labelled with their heading", () => {
    const chunks = chunkMarkdown(longDoc(4, 6), "Doc", { maxTokens: 128, overlapRatio: 0.15 });

    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((c, i) => {
      expect(c.idx).toBe(i);
      expect(bodyOf(c.text).length).toBeLessThanOrEqual(128 * 4);
    });

    // Each chunk starts with overlap carried from the end of the previous one.
    for (let i = 0; i + 1 < chunks.length; i++) {
      const prev = bodyOf(chunks[i]!.text);
      const nextStart = bodyOf(chunks[i + 1]!.text).slice(0, 40);
      expect(prev.slice(-(128 * 4 * 0.15 + 40))).toContain(nextStart);
    }

    const part3 = chunks.find((c) => c.heading === "Part 3");
    expect(part3?.text.startsWith("Doc — Part 3\n\n")).toBe(true);
    expect(part3?.text).toContain("section 3 paragraph");
  });

  it("splits a giant paragraph that has no blank lines", () => {
    const chunks = chunkMarkdown(sentence.repeat(200), "T", { maxTokens: 128 });
    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c) => expect(bodyOf(c.text).length).toBeLessThanOrEqual(512));
  });
});
