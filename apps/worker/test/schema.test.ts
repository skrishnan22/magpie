import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("serves /health", async () => {
    const res = await exports.default.fetch(new Request("https://magpie.test/health"));
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("schema", () => {
  it("finds chunks by stemmed keyword and cascades chunk deletes with their document", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO documents (id, canonical_url, url, title) VALUES ('d1', 'https://a.test', 'https://a.test', 'Magpies')"),
      env.DB.prepare("INSERT INTO chunks (id, document_id, idx, text, embedding_model) VALUES ('t:d1:0', 'd1', 0, 'Magpies hoard shiny things', 'm')"),
      env.DB.prepare("INSERT INTO chunks_fts (text, title, chunk_id, document_id) VALUES ('Magpies hoard shiny things', 'Magpies', 't:d1:0', 'd1')"),
    ]);

    const hit = await env.DB.prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ?").bind('"hoarding"').first();
    expect(hit).toEqual({ chunk_id: "t:d1:0" });

    await env.DB.prepare("DELETE FROM documents WHERE id = 'd1'").run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM chunks").first("n")).toBe(0);
  });
});
