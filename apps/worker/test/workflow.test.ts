import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING_MODEL } from "../src/embed";

afterEach(() => vi.restoreAllMocks());

async function seedDocument(id: string) {
  await env.DB.prepare("INSERT INTO documents (id, canonical_url, url, title) VALUES (?, ?, ?, ?)")
    .bind(id, `https://articles.test/${id}`, `https://articles.test/${id}`, "Saved article")
    .run();
}

function mockServices(body: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(body, { headers: { "content-type": "text/plain" } }),
  );
  vi.spyOn(env.AI, "run").mockImplementation(async (_model, input) => {
    if (!("text" in input) || !Array.isArray(input.text)) throw new Error("expected embedding text");
    return { data: input.text.map(() => Array<number>(1024).fill(0.1)) };
  });
  const upsert = vi.spyOn(env.VECTORS, "upsert").mockResolvedValue({ ids: [], count: 0 });
  const remove = vi.spyOn(env.VECTORS, "deleteByIds").mockResolvedValue({ ids: [], count: 0 });
  return { upsert, remove };
}

describe("IngestWorkflow", () => {
  it("persists extracted content and replaces stale keyword/vector entries on rerun", async () => {
    const id = "workflow-success";
    await seedDocument(id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO chunks (id, document_id, idx, text, embedding_model) VALUES (?, ?, 9, 'obsolete', 'old')",
      ).bind(`test:${id}:9`, id),
      env.DB.prepare(
        "INSERT INTO chunks_fts (text, title, chunk_id, document_id) VALUES ('obsolete', 'Old', ?, ?)",
      ).bind(`test:${id}:9`, id),
    ]);
    const body = "Magpies collect shiny treasure. ".repeat(20);
    const { upsert, remove } = mockServices(body);
    upsert.mockRejectedValueOnce(new Error("vector service unavailable"));

    for (const suffix of ["first", "again"]) {
      const instanceId = `${id}-${suffix}`;
      await using instance = await introspectWorkflowInstance(env.INGEST, instanceId);
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
      });
      await env.INGEST.create({ id: instanceId, params: { documentId: id } });
      await instance.waitForStatus("complete");
      const output = await instance.getOutput();
      expect(output).toEqual({ documentId: id, chunks: 1 });
    }

    const doc = await env.DB.prepare(
      "SELECT extract_status, extract_method, content_chars, embedding_model, error, attempts FROM documents WHERE id = ?",
    )
      .bind(id)
      .first();
    expect(doc).toEqual({
      extract_status: "ok",
      extract_method: "plain",
      content_chars: body.trim().length,
      embedding_model: EMBEDDING_MODEL,
      error: null,
      attempts: 2,
    });
    const stored = await env.BUCKET.get(`md/${id}.md`);
    expect(await stored?.text()).toBe(body.trim());
    const raw = await env.BUCKET.get(`raw/${id}`);
    expect(await raw?.text()).toBe(body);
    const chunks = await env.DB.prepare("SELECT id FROM chunks WHERE document_id = ?").bind(id).all();
    expect(chunks.results).toEqual([{ id: `test:${id}:0` }]);
    const hits = await env.DB.prepare(
      "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'treasure'",
    ).all();
    expect(hits.results).toEqual([{ chunk_id: `test:${id}:0` }]);
    const obsolete = await env.DB.prepare(
      "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'obsolete'",
    ).all();
    expect(obsolete.results).toEqual([]);
    expect(remove).toHaveBeenCalledWith([`test:${id}:9`]);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: `test:${id}:0`,
        namespace: "test",
        values: Array(1024).fill(0.1),
      }),
    ]);
  });

  it.each(["small article", ""])(
    "marks short or empty extraction thin without inventing chunks: %j",
    async (body) => {
      const id = body ? "workflow-thin" : "workflow-empty";
      await seedDocument(id);
      const { upsert } = mockServices(body);
      await using instance = await introspectWorkflowInstance(env.INGEST, id);
      await env.INGEST.create({ id, params: { documentId: id } });
      await instance.waitForStatus("complete");
      const status = await env.DB.prepare("SELECT extract_status FROM documents WHERE id = ?")
        .bind(id)
        .first("extract_status");
      expect(status).toBe("thin");
      const chunks = await env.DB.prepare("SELECT count(*) AS n FROM chunks WHERE document_id = ?")
        .bind(id)
        .first("n");
      expect(chunks).toBe(body ? 1 : 0);
      expect(upsert).toHaveBeenCalledTimes(body ? 1 : 0);
    },
  );

  it.each([
    ["unsupported", "image/png", "png bytes", "unsupported content type"],
    ["oversized", "text/plain", "a".repeat(15 * 1024 * 1024 + 1), "response too large"],
  ])("fails %s content without retries or indexing", async (kind, contentType, body, error) => {
    const id = `workflow-${kind}`;
    await seedDocument(id);
    const { upsert } = mockServices(body);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(body, { headers: { "content-type": contentType } }));
    await using instance = await introspectWorkflowInstance(env.INGEST, id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.INGEST.create({ id, params: { documentId: id } });
    await instance.waitForStatus("errored");
    const doc = await env.DB.prepare("SELECT extract_status, error FROM documents WHERE id = ?")
      .bind(id)
      .first();
    expect(doc).toEqual({
      extract_status: "failed",
      error: expect.stringContaining(error),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    [403, 1],
    [404, 1],
    [429, 4],
    [503, 4],
  ])("records HTTP %i as failed after %i fetch attempts", async (status, attempts) => {
    const id = `workflow-http-${status}`;
    await seedDocument(id);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("unavailable", { status }));
    await using instance = await introspectWorkflowInstance(env.INGEST, id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.INGEST.create({ id, params: { documentId: id } });
    await instance.waitForStatus("errored");
    const doc = await env.DB.prepare("SELECT extract_status, error FROM documents WHERE id = ?")
      .bind(id)
      .first();
    expect(doc).toEqual({
      extract_status: "failed",
      error: expect.stringContaining(`HTTP ${status}`),
    });
    expect(fetch).toHaveBeenCalledTimes(attempts);
  });
});
