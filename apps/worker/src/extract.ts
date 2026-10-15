import { Readability } from "@mozilla/readability";
import { NonRetryableError } from "cloudflare:workflows";
import { parseHTML } from "linkedom";

export interface MarkdownConverter {
  toMarkdown(doc: { name: string; blob: Blob }): Promise<{ format: string; data?: string; error?: string }>;
}

export type ExtractMethod = "readability" | "html" | "pdf" | "plain";

export interface Extracted {
  title: string | null;
  markdown: string;
  method: ExtractMethod;
}

const HTML_TYPES = new Set(["", "text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown"]);

export async function extractMarkdown(
  converter: MarkdownConverter,
  body: ArrayBuffer,
  contentType: string,
  url: string,
): Promise<Extracted> {
  if (contentType === "application/pdf") {
    const markdown = await convert(converter, "document.pdf", new Blob([body], { type: contentType }));
    return { title: null, markdown, method: "pdf" };
  }
  if (TEXT_TYPES.has(contentType)) {
    return { title: null, markdown: new TextDecoder().decode(body).trim(), method: "plain" };
  }
  if (HTML_TYPES.has(contentType)) {
    const html = new TextDecoder().decode(body);
    const article = readable(html, url);
    const source = article?.content ?? html;
    let markdown: string;
    try {
      markdown = await convert(converter, "page.html", new Blob([source], { type: "text/html" }));
    } catch (err) {
      if (!article) throw err;
      markdown = article.textContent.trim();
    }
    return { title: article?.title ?? null, markdown, method: article ? "readability" : "html" };
  }
  throw new NonRetryableError(`unsupported content type: ${contentType}`);
}

function readable(html: string, url: string): { title: string | null; content: string; textContent: string } | null {
  const { document } = parseHTML(html);
  if (!document.querySelector("base")) {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  if (!article?.content) return null;
  return { title: article.title || null, content: article.content, textContent: article.textContent ?? "" };
}

async function convert(converter: MarkdownConverter, name: string, blob: Blob): Promise<string> {
  const result = await converter.toMarkdown({ name, blob });
  if (result.format === "error" || result.data === undefined) {
    throw new Error(`toMarkdown failed: ${result.error ?? "no data"}`);
  }
  return result.data.trim();
}
