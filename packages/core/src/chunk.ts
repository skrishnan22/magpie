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

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

interface Block {
  heading: string | null;
  text: string;
}

export function chunkMarkdown(markdown: string, title: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 512;
  const overlapRatio = options.overlapRatio ?? 0.15;
  const body = markdown.trim();
  if (!body) return [];

  const withPrefix = (heading: string | null, text: string) => {
    const prefix = [title.trim(), heading].filter(Boolean).join(" — ");
    return prefix ? `${prefix}\n\n${text}` : text;
  };

  if (estimateTokens(body) <= maxTokens) return [{ idx: 0, heading: null, text: withPrefix(null, body) }];

  const budget = maxTokens * CHARS_PER_TOKEN;
  const overlap = Math.floor(budget * overlapRatio);
  // Blocks are sized so that overlap + separator + block always fits in one chunk.
  const blocks = toBlocks(body, budget - overlap - 2);

  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let size = 0;
  let heading: string | null = null;
  let fresh = true; // `parts` holds only overlap carried over from the previous chunk

  const emit = () => {
    const text = parts.join("\n\n");
    chunks.push({ idx: chunks.length, heading, text: withPrefix(heading, text) });
    const tail = overlapTail(text, overlap);
    parts = tail ? [tail] : [];
    size = tail.length;
    fresh = true;
  };

  for (const block of blocks) {
    if (!fresh && size + 2 + block.text.length > budget) emit();
    if (fresh) {
      heading = block.heading;
      fresh = false;
    }
    size += (parts.length ? 2 : 0) + block.text.length;
    parts.push(block.text);
  }
  if (!fresh) emit();
  return chunks;
}

// Paragraphs (split on blank lines), each tagged with the heading it sits under.
function toBlocks(markdown: string, maxBlockChars: number): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  for (const raw of markdown.split(/\n{2,}/)) {
    const text = raw.trim();
    if (!text) continue;
    const match = HEADING.exec(text.split("\n", 1)[0]!);
    if (match) heading = match[1]!;
    for (const piece of splitLong(text, maxBlockChars)) blocks.push({ heading, text: piece });
  }
  return blocks;
}

// Hard-split oversized paragraphs, preferring word boundaries.
function splitLong(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// The last ~`overlap` chars of a chunk, starting at a word boundary.
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0) return "";
  const start = text.length - overlap;
  if (start <= 0) return text;
  const space = text.indexOf(" ", start);
  return space === -1 ? "" : text.slice(space + 1);
}
