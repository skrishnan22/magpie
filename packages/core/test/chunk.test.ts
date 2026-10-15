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
  it.each([
    "```md\n~~~\n# fake\n" + sentence.repeat(10) + "\n```",
    "````md\n```\n# fake\n" + sentence.repeat(10) + "\n````",
    "   ```md\n# fake\n" + sentence.repeat(10) + "\n   ```",
  ])("ignores headings inside fenced code", async (markdown) => {
    const chunks = await chunkMarkdown(markdown, "Doc", { maxTokens: 32 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.heading === null)).toBe(true);
  });

  it("preserves hashes that belong to a heading's text", async () => {
    const chunks = await chunkMarkdown("## C#\n\nA language.", "Doc");
    expect(chunks[0]?.heading).toBe("C#");
  });

  it("keeps a short document as one chunk prefixed with its title", async () => {
    expect(await chunkMarkdown("hello world", "My Title")).toEqual([
      { idx: 0, heading: null, text: "My Title\n\nhello world" },
    ]);
  });

  it("splits long documents into bounded chunks labelled with their heading, losing no text", async () => {
    const doc = longDoc(4, 6);
    const chunks = await chunkMarkdown(doc, "Doc", { maxTokens: 128 });

    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((c, i) => {
      expect(c.idx).toBe(i);
      expect(bodyOf(c.text).length).toBeLessThanOrEqual(128 * 4);
    });
    for (const para of doc.split("\n\n")) expect(chunks.some((c) => c.text.includes(para))).toBe(true);

    const part3 = chunks.find((c) => c.heading === "Part 3");
    expect(part3?.text.startsWith("Doc — Part 3\n\n")).toBe(true);
    expect(part3?.text).toContain("section 3 paragraph");
  });

  it("splits a giant paragraph into overlapping chunks", async () => {
    const chunks = await chunkMarkdown(sentence.repeat(200), "T", { maxTokens: 128 });
    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c) => expect(bodyOf(c.text).length).toBeLessThanOrEqual(512));

    // A cut mid-paragraph carries the end of the previous chunk into the next one.
    for (let i = 0; i + 1 < chunks.length; i++) {
      const prevEnd = bodyOf(chunks[i]!.text).slice(-30);
      expect(bodyOf(chunks[i + 1]!.text).slice(0, 128 * 4 * 0.15 + 30)).toContain(prevEnd);
    }
  });
});
