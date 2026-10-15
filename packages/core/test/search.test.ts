import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, toFtsQuery } from "../src/search";

describe("reciprocalRankFusion", () => {
  it("ranks ids that several retrievers agree on above single-list leaders", () => {
    const fused = reciprocalRankFusion([
      ["a", "shared"],
      ["b", "shared"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["shared", "a", "b"]);
    expect(fused[0]!.score).toBeCloseTo(2 / 62);
    expect(fused[1]!.score).toBeCloseTo(1 / 61);
  });

  it("counts an id repeated within one ranking once, at its best rank", () => {
    expect(reciprocalRankFusion([["a", "b", "a"]])).toEqual([
      { id: "a", score: 1 / 61 },
      { id: "b", score: 1 / 62 },
    ]);
  });

  it("breaks score ties by id so results are deterministic", () => {
    expect(reciprocalRankFusion([["z"], ["m"], ["a"]]).map((f) => f.id)).toEqual(["a", "m", "z"]);
  });

  it("honours a custom k", () => {
    expect(reciprocalRankFusion([["a"]], 0)).toEqual([{ id: "a", score: 1 }]);
  });

  it.each([[[]], [[[], []]]])("returns nothing for empty rankings %j", (rankings) => {
    expect(reciprocalRankFusion(rankings)).toEqual([]);
  });
});

describe("toFtsQuery", () => {
  it("quotes, lowercases and dedupes terms joined by OR", () => {
    expect(toFtsQuery("Rust async rust")).toBe('"rust" OR "async"');
  });

  it("neutralises FTS5 syntax so input can't act as operators or column filters", () => {
    expect(toFtsQuery('title:foo AND "bar" NOT baz* NEAR(qux) ^start -x')).toBe(
      '"title" OR "foo" OR "and" OR "bar" OR "not" OR "baz" OR "near" OR "qux" OR "start" OR "x"',
    );
  });

  it("keeps Unicode letters and digits", () => {
    expect(toFtsQuery("café naïve 東京 v8")).toBe('"café" OR "naïve" OR "東京" OR "v8"');
  });

  it.each(["", "   ", '"*()^:-'])("returns null when %j has no terms", (query) => {
    expect(toFtsQuery(query)).toBeNull();
  });
});
