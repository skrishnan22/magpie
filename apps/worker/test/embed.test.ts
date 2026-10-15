import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_MODEL, embedQuery, embedTexts, type EmbeddingRunner } from "../src/embed";

describe("embeddings", () => {
  it("batches document text and preserves vector order", async () => {
    const run = vi.fn<EmbeddingRunner["run"]>(async (_model, { text }) => ({
      data: text.map((value) => Array<number>(1024).fill(Number(value))),
    }));
    const texts = Array.from({ length: 40 }, (_, i) => String(i));
    const vectors = await embedTexts({ run }, texts);
    expect(run.mock.calls.map(([, input]) => input.text.length)).toEqual([16, 16, 8]);
    expect(run.mock.calls.flatMap(([, input]) => input.text)).toEqual(texts);
    expect(vectors.map((vector) => vector[0])).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(run.mock.calls[0]?.[0]).toBe(EMBEDDING_MODEL);
  });

  it.each([
    null,
    {},
    { data: [] },
    { data: [null] },
    { data: [Array(768).fill(0)] },
    { data: [Array(1024).fill("0")] },
    { data: [Array(1024).fill(Infinity)] },
  ])("rejects malformed model output before indexing (case %#)", async (response) => {
    const ai: EmbeddingRunner = {
      async run() {
        return response;
      },
    };
    const result = embedTexts(ai, ["article"]);
    await expect(result).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("does not call AI for an empty document", async () => {
    const run = vi.fn<EmbeddingRunner["run"]>();
    const vectors = await embedTexts({ run }, []);
    expect(vectors).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("instructs query retrieval without modifying document text", async () => {
    const run = vi.fn<EmbeddingRunner["run"]>(async () => ({
      data: [Array<number>(1024).fill(0.1)],
    }));
    const vector = await embedQuery({ run }, "rust async");
    expect(run.mock.calls[0]?.[1].text[0]).toMatch(/^Instruct: .+\nQuery: rust async$/);
    expect(vector).toHaveLength(1024);
  });
});
