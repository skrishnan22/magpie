import { reciprocalRankFusion, toFtsQuery } from "@magpie/core";
import { embedQuery } from "./embed";

export interface SaveInfo {
  source: string;
  saved_at: string;
  folder: string | null;
}

export interface SearchHit {
  document_id: string;
  title: string | null;
  url: string;
  heading: string | null;
  text: string;
  score: number;
  saves: SaveInfo[];
}

export interface DocumentView {
  id: string;
  title: string | null;
  url: string;
  extract_status: string;
  saves: SaveInfo[];
  markdown: string | null;
  truncated: boolean;
}

const MAX_DOCUMENT_CHARS = 40_000;

export async function ftsSearch(db: D1Database, query: string, limit: number): Promise<string[]> {
  const match = toFtsQuery(query);
  if (!match) return [];
  const { results } = await db
    .prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?")
    .bind(match, limit)
    .all<{ chunk_id: string }>();
  return results.map((r) => r.chunk_id);
}

async function vectorSearch(env: Env, query: string, limit: number): Promise<string[]> {
  const vector = await embedQuery(env.AI, query);
  const { matches } = await env.VECTORS.query(vector, {
    topK: limit,
    namespace: env.VECTOR_NAMESPACE,
  });
  return matches.map((m) => m.id);
}

export async function hybridSearch(env: Env, query: string, limit: number): Promise<SearchHit[]> {
  const pool = Math.min(Math.max(limit * 4, 20), 50);
  const [semantic, keyword] = await Promise.all([vectorSearch(env, query, pool), ftsSearch(env.DB, query, pool)]);
  const fused = reciprocalRankFusion([semantic, keyword]).slice(0, 90); // D1 allows 100 bound params
  if (!fused.length) return [];

  const ids = fused.map((f) => f.id);
  const { results: rows } = await env.DB.prepare(
    `SELECT c.id, c.document_id, c.heading, c.text, d.title, d.url
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      document_id: string;
      heading: string | null;
      text: string;
      title: string | null;
      url: string;
    }>();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // One hit per document: its best-ranked chunk. Ids missing from D1 (orphan vectors) are skipped.
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const { id, score } of fused) {
    const row = byId.get(id);
    if (!row || seen.has(row.document_id)) continue;
    seen.add(row.document_id);
    hits.push({
      document_id: row.document_id,
      title: row.title,
      url: row.url,
      heading: row.heading,
      text: row.text,
      score: Number(score.toFixed(5)),
      saves: [],
    });
    if (hits.length === limit) break;
  }

  const saves = await savesFor(
    env.DB,
    hits.map((h) => h.document_id),
  );
  for (const hit of hits) hit.saves = saves.get(hit.document_id) ?? [];
  return hits;
}

export async function getDocument(env: Env, id: string): Promise<DocumentView | null> {
  const doc = await env.DB.prepare("SELECT id, title, url, extract_status, markdown_key FROM documents WHERE id = ?")
    .bind(id)
    .first<{
      id: string;
      title: string | null;
      url: string;
      extract_status: string;
      markdown_key: string | null;
    }>();
  if (!doc) return null;
  const stored = doc.markdown_key ? await env.BUCKET.get(doc.markdown_key) : null;
  const markdown = stored ? await stored.text() : null;
  const saves = await savesFor(env.DB, [id]);
  return {
    id: doc.id,
    title: doc.title,
    url: doc.url,
    extract_status: doc.extract_status,
    saves: saves.get(id) ?? [],
    markdown: markdown?.slice(0, MAX_DOCUMENT_CHARS) ?? null,
    truncated: (markdown?.length ?? 0) > MAX_DOCUMENT_CHARS,
  };
}

async function savesFor(db: D1Database, documentIds: string[]): Promise<Map<string, SaveInfo[]>> {
  const out = new Map<string, SaveInfo[]>();
  if (!documentIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT document_id, source, saved_at, folder FROM saves
        WHERE document_id IN (${documentIds.map(() => "?").join(",")}) ORDER BY saved_at DESC`,
    )
    .bind(...documentIds)
    .all<SaveInfo & { document_id: string }>();
  for (const { document_id, ...save } of results) {
    out.set(document_id, [...(out.get(document_id) ?? []), save]);
  }
  return out;
}
