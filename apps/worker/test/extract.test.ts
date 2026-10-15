import { describe, expect, it } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { extractMarkdown, type MarkdownConverter } from "../src/extract";

const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

// Echoes the blob back as "markdown" so tests can see what was sent to the converter.
const echo: MarkdownConverter & { calls: { name: string; type: string }[] } = {
  calls: [],
  async toMarkdown({ name, blob }) {
    echo.calls.push({ name, type: blob.type });
    return { format: "markdown", data: await blob.text() };
  },
};
const failing: MarkdownConverter = {
  async toMarkdown() {
    return { format: "error", error: "boom" };
  },
};

const body = "Magpies hide their treasure in places other birds would never think to look. ".repeat(20);
const page = `<!doctype html><html><head><title>How magpies hoard | Bird Blog</title></head><body>
  <nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav>
  <article><h1>How magpies hoard</h1><p>${body}</p><p>${body}</p></article>
  <footer>Sign up for our newsletter</footer>
</body></html>`;

describe("extractMarkdown", () => {
  it("runs readable article HTML through the converter", async () => {
    const out = await extractMarkdown(echo, encode(page), "text/html", "https://birds.test/post");
    expect(out.method).toBe("readability");
    expect(out.title).toContain("How magpies hoard");
    expect(out.markdown).toContain("Magpies hide their treasure");
    expect(out.markdown).not.toContain("Sign up for our newsletter");
  });

  it("falls back to article text when the converter fails", async () => {
    const out = await extractMarkdown(failing, encode(page), "text/html", "https://birds.test/post");
    expect(out.method).toBe("readability");
    expect(out.markdown).toContain("Magpies hide their treasure");
  });

  it("sends PDFs to the converter", async () => {
    echo.calls = [];
    const out = await extractMarkdown(echo, encode("%PDF-1.7 fake"), "application/pdf", "https://x.test/a.pdf");
    expect(out.method).toBe("pdf");
    expect(echo.calls).toEqual([{ name: "document.pdf", type: "application/pdf" }]);
  });

  it("passes plain text through", async () => {
    const out = await extractMarkdown(echo, encode("  just text \n"), "text/plain", "https://x.test/a.txt");
    expect(out).toEqual({ title: null, markdown: "just text", method: "plain" });
  });

  it("refuses unsupported content types without retrying", async () => {
    const extraction = extractMarkdown(echo, encode("\x89PNG"), "image/png", "https://x.test/a.png");
    await expect(extraction).rejects.toBeInstanceOf(NonRetryableError);
  });
});
