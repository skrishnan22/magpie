import { describe, expect, it } from "vitest";
import { canonicalizeUrl, documentId } from "../src/url";

describe("canonicalizeUrl", () => {
  it("maps common variants of the same article to one URL", () => {
    const variants = [
      "https://example.com/blog/rust-async?b=2&a=1",
      "http://www.example.com/blog/rust-async/?a=1&b=2",
      "https://example.com/blog/rust-async?utm_campaign=x&a=1&fbclid=abc&b=2",
      "https://example.com/blog/rust-async?a=1&b=2#comments",
      "  https://EXAMPLE.com/blog/rust-async?a=1&b=2  ",
    ];
    expect(new Set(variants.map(canonicalizeUrl))).toEqual(new Set(["https://example.com/blog/rust-async?a=1&b=2"]));
  });

  it.each(["javascript:alert(1)", "chrome://settings", "file:///Users/me/a.html", "not a url"])(
    "rejects non-web URL %s",
    (url) => {
      expect(() => canonicalizeUrl(url)).toThrow();
    },
  );
});

describe("documentId", () => {
  it("is a short, stable id derived from the canonical URL", async () => {
    const a = await documentId("https://example.com/a");
    expect(a).toMatch(/^d_[0-9a-f]{24}$/);
    expect(await documentId("https://example.com/a")).toBe(a);
    expect(await documentId("https://example.com/b")).not.toBe(a);
  });
});
