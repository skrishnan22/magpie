import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const item = (source_id: string, url = "https://example.com/article") => ({
  source: "chrome",
  source_id,
  url,
  title: "Saved article",
  saved_at: "2026-01-02T03:04:05.000Z",
  folder: "Reading / Systems",
});

const post = (body: unknown) =>
  exports.default.fetch(
    new Request("https://magpie.test/ingest", {
      method: "POST",
      headers: { authorization: "Bearer test-ingest-token", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let workflows: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM saves"), env.DB.prepare("DELETE FROM documents")]);
  workflows = await introspectWorkflow(env.INGEST);
  await workflows.modifyAll(async (m) => {
    // Extraction/indexing have their own integration tests; keep dispatch tests offline.
    await m.mockStepResult(
      { name: "fetch" },
      { rawKey: "raw/test", contentType: "text/plain", finalUrl: "https://example.com/article" },
    );
    await m.mockStepResult(
      { name: "extract" },
      { markdownKey: "md/test.md", title: "Article", method: "plain", chars: 600 },
    );
    await m.mockStepResult({ name: "index" }, { chunks: 1 });
  });
});
afterEach(async () => {
  try {
    const instances = await workflows.get();
    await Promise.all(instances.map((instance) => instance.waitForStatus("complete")));
  } finally {
    await workflows.dispose();
    vi.restoreAllMocks();
  }
});

describe("POST /ingest", () => {
  it("accepts minimal saves, supplies a timestamp, and normalizes timestamp offsets", async () => {
    const before = Date.now();
    const response = await post({
      items: [
        { source: "chrome", source_id: "minimal", url: "https://example.com/article" },
        { ...item("offset"), saved_at: "2026-01-02T08:34:05+05:30" },
      ],
    });
    expect(await response.json()).toMatchObject({ saves: 2, new_documents: 1, failed_to_start: [] });
    const minimal = await env.DB.prepare(
      "SELECT saved_at, title, folder FROM saves WHERE source_id = 'minimal'",
    ).first<{ saved_at: string; title: string | null; folder: string | null }>();
    expect(minimal?.title).toBeNull();
    expect(minimal?.folder).toBeNull();
    const savedAt = Date.parse(minimal?.saved_at ?? "");
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(Date.now());
    const offset = await env.DB.prepare("SELECT saved_at FROM saves WHERE source_id = 'offset'").first(
      "saved_at",
    );
    expect(offset).toBe("2026-01-02T03:04:05.000Z");
  });

  it("rolls back documents and saves together if the database rejects a save", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER reject_ingest_test BEFORE INSERT ON saves
      WHEN NEW.source_id = 'reject' BEGIN SELECT RAISE(ABORT, 'test save rejected'); END`,
    ).run();
    try {
      const response = post({ items: [item("accepted"), item("reject", "https://example.com/rejected")] });
      await expect(response).rejects.toThrow("test save rejected");
      const documents = await env.DB.prepare("SELECT count(*) AS n FROM documents").first("n");
      const saves = await env.DB.prepare("SELECT count(*) AS n FROM saves").first("n");
      expect(documents).toBe(0);
      expect(saves).toBe(0);
      expect(await workflows.get()).toHaveLength(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_ingest_test").run();
    }
  });

  it("records save metadata, merges URL variants, and dispatches one real workflow", async () => {
    const response = await post({
      items: [item("first"), item("second", "http://www.example.com/article/?utm_source=x#top")],
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ saves: 2, new_documents: 1, failed_to_start: [], skipped: [] });
    const instances = await workflows.get();
    expect(instances).toHaveLength(1);
    await instances[0]!.waitForStatus("complete");
    const document = await env.DB.prepare(
      "SELECT id, canonical_url, url, workflow_started, extract_status FROM documents",
    ).first();
    expect(document).toMatchObject({
      canonical_url: "https://example.com/article",
      url: "https://example.com/article",
      workflow_started: 1,
      extract_status: "ok",
    });
    const output = await instances[0]!.getOutput();
    expect(output).toEqual({ documentId: document?.id, chunks: 1 });
    const saves = await env.DB.prepare(
      "SELECT source, source_id, saved_at, title, folder, document_id FROM saves ORDER BY source_id",
    ).all();
    expect(saves.results).toEqual(
      ["first", "second"].map((source_id) => ({
        source: "chrome",
        source_id,
        saved_at: "2026-01-02T03:04:05.000Z",
        title: "Saved article",
        folder: "Reading / Systems",
        document_id: document?.id,
      })),
    );
    const again = await post({ items: [item("first"), item("second")] });
    expect(await again.json()).toEqual({ saves: 0, new_documents: 0, failed_to_start: [], skipped: [] });
    expect(await workflows.get()).toHaveLength(1);
  });

  it("does not create orphan documents when a save ID is repeated with a different URL", async () => {
    const response = await post({ items: [item("same"), item("same", "https://example.com/other")] });
    expect(await response.json()).toEqual({ saves: 1, new_documents: 1, failed_to_start: [], skipped: [] });
    const again = await post({ items: [item("same", "https://example.com/changed")] });
    expect(await again.json()).toEqual({ saves: 0, new_documents: 0, failed_to_start: [], skipped: [] });
    const count = await env.DB.prepare("SELECT count(*) AS n FROM documents").first("n");
    expect(count).toBe(1);
  });

  it("skips unsupported and malformed URLs while accepting valid items", async () => {
    const response = await post({
      items: [
        item("js", "javascript:void(0)"),
        item("chrome", "chrome://settings"),
        item("file", "file:///tmp/book"),
        item("bad", "not a URL"),
        item("good"),
      ],
    });
    expect(await response.json()).toEqual({
      saves: 1,
      new_documents: 1,
      failed_to_start: [],
      skipped: ["js", "chrome", "file", "bad"].map((source_id) =>
        expect.objectContaining({ source_id, reason: expect.any(String) }),
      ),
    });
  });

  it("does not dispatch work when every URL is skipped", async () => {
    const response = await post({ items: [item("js", "javascript:void(0)")] });
    expect(await response.json()).toMatchObject({
      saves: 0,
      new_documents: 0,
      failed_to_start: [],
      skipped: [expect.objectContaining({ source_id: "js" })],
    });
    expect(await workflows.get()).toHaveLength(0);
  });

  it("recovers a failed workflow start when the same batch is resent", async () => {
    vi.spyOn(env.INGEST, "createBatch").mockRejectedValueOnce(new Error("workflow service unavailable"));
    const response = await post({ items: [item("retry")] });
    const doc = await env.DB.prepare("SELECT id, workflow_started FROM documents").first();
    expect(doc?.workflow_started).toBe(0);
    expect(await response.json()).toEqual({
      saves: 1,
      new_documents: 1,
      failed_to_start: [doc?.id],
      skipped: [],
    });
    const retry = await post({ items: [item("retry")] });
    expect(await retry.json()).toEqual({ saves: 0, new_documents: 0, failed_to_start: [], skipped: [] });
    expect(await workflows.get()).toHaveLength(1);
    const started = await env.DB.prepare("SELECT workflow_started FROM documents").first("workflow_started");
    expect(started).toBe(1);
  });

  it("adopts an existing workflow after its creation response was lost", async () => {
    const createBatch = env.INGEST.createBatch.bind(env.INGEST);
    vi.spyOn(env.INGEST, "createBatch").mockImplementationOnce(async (options) => {
      await createBatch(options);
      throw new Error("response lost after creation");
    });
    const first = await post({ items: [item("lost-response")] });
    const doc = await env.DB.prepare("SELECT id FROM documents").first();
    expect(await first.json()).toMatchObject({ failed_to_start: [doc?.id] });
    const retry = await post({ items: [item("lost-response")] });
    expect(await retry.json()).toEqual({ saves: 0, new_documents: 0, failed_to_start: [], skipped: [] });
    expect(await workflows.get()).toHaveLength(1);
    const started = await env.DB.prepare("SELECT workflow_started FROM documents").first("workflow_started");
    expect(started).toBe(1);
  });

  it("handles concurrent submissions without duplicate documents, saves, or workflows", async () => {
    const responses = await Promise.all([
      post({ items: [item("concurrent")] }),
      post({ items: [item("concurrent")] }),
    ]);
    const results = await Promise.all(
      responses.map((response) =>
        response.json<{ saves: number; new_documents: number; failed_to_start: string[] }>(),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.saves, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.new_documents, 0)).toBe(1);
    expect(results.flatMap((result) => result.failed_to_start)).toEqual([]);
    expect(await workflows.get()).toHaveLength(1);
  });

  it("accepts the maximum batch of 100 saves without duplicate workflows", async () => {
    const response = await post({ items: Array.from({ length: 100 }, (_, i) => item(`batch-${i}`)) });
    expect(await response.json()).toEqual({ saves: 100, new_documents: 1, failed_to_start: [], skipped: [] });
    expect(await workflows.get()).toHaveLength(1);
  });

  it.each([
    "{invalid",
    null,
    {},
    { items: [] },
    { items: Array.from({ length: 101 }, (_, i) => item(String(i))) },
    { items: [{ ...item("bad"), source: "x" }] },
    { items: [{ ...item("bad"), source_id: "" }] },
    { items: [{ ...item("bad"), title: 123 }] },
    { items: [{ ...item("bad"), saved_at: "yesterday" }] },
  ])("rejects invalid input without persisting or dispatching (case %#)", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM documents").first("n");
    expect(count).toBe(0);
    expect(await workflows.get()).toHaveLength(0);
  });
});
