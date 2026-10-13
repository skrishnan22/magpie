export interface Fused {
  id: string;
  score: number;
}

// Reciprocal Rank Fusion: each list contributes 1 / (k + rank), so items several retrievers agree on rise to the top.
// Only ranks matter, which is why keyword (bm25) and vector (cosine) results can be merged without normalizing scores.
export function reciprocalRankFusion(rankings: string[][], k = 60): Fused[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of ranking) {
      if (seen.has(id)) continue;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      rank++;
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Every term is quoted, so user input can never be parsed as FTS5 operators or column filters.
export function toFtsQuery(query: string): string | null {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}
