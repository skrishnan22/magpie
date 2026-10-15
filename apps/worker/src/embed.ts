import { NonRetryableError } from "cloudflare:workflows";

export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMS = 1024;
const BATCH_SIZE = 16;
// Only queries carry retrieval instructions; document text is embedded as-is.
const QUERY_INSTRUCTION =
  "Instruct: Given a search query, retrieve relevant passages from the user's saved articles and posts\nQuery: ";

export interface EmbeddingRunner {
  run(model: typeof EMBEDDING_MODEL, input: { text: string[] }): Promise<unknown>;
}

export async function embedTexts(ai: EmbeddingRunner, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await ai.run(EMBEDDING_MODEL, { text: batch });
    if (
      typeof response !== "object" ||
      response === null ||
      !("data" in response) ||
      !Array.isArray(response.data) ||
      response.data.length !== batch.length
    ) {
      throw new NonRetryableError(`expected ${batch.length} embedding vectors`);
    }
    for (const vector of response.data) {
      if (
        !Array.isArray(vector) ||
        vector.length !== EMBEDDING_DIMS ||
        !vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new NonRetryableError(`expected ${EMBEDDING_DIMS} finite numeric dimensions`);
      }
      vectors.push(vector);
    }
  }
  return vectors;
}

export async function embedQuery(ai: EmbeddingRunner, query: string): Promise<number[]> {
  const vectors = await embedTexts(ai, [QUERY_INSTRUCTION + query]);
  return vectors[0]!;
}
