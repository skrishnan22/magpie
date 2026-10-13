import { MarkdownTextSplitter } from "@langchain/textsplitters";

export interface Chunk {
  idx: number;
  heading: string | null;
  /** Chunk body prefixed with `title — heading` (what gets embedded and indexed). */
  text: string;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapRatio?: number;
}

const CHARS_PER_TOKEN = 4;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

// Splitting is LangChain's; we only add the `title — heading` prefix that makes chunks retrievable.
export async function chunkMarkdown(markdown: string, title: string, options: ChunkOptions = {}): Promise<Chunk[]> {
  const chunkSize = (options.maxTokens ?? 512) * CHARS_PER_TOKEN;
  const chunkOverlap = Math.floor(chunkSize * (options.overlapRatio ?? 0.15));
  const body = markdown.trim();
  if (!body) return [];

  const splitter = new MarkdownTextSplitter({ chunkSize, chunkOverlap });
  const pieces = await splitter.splitText(body);
  const headings = headingOffsets(body);

  let cursor = 0;
  return pieces.map((text, idx) => {
    // Pieces are in order and overlap, so each one starts at or after the previous start.
    const found = body.indexOf(text, cursor);
    const start = found === -1 ? cursor : found;
    cursor = start + 1;
    const heading = headings.findLast((h) => h.offset <= start)?.text ?? null;
    const prefix = [title.trim(), heading].filter(Boolean).join(" — ");
    return { idx, heading, text: prefix ? `${prefix}\n\n${text}` : text };
  });
}

// Where each markdown heading starts, ignoring `#` lines inside fenced code.
function headingOffsets(markdown: string): { offset: number; text: string }[] {
  const out: { offset: number; text: string }[] = [];
  let offset = 0;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) out.push({ offset, text: match[1]! });
    offset += line.length + 1;
  }
  return out;
}
