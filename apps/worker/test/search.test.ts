import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ftsSearch, getDocument, hybridSearch } from "../src/search";

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM saves"),
    env.DB.prepare("DELETE FROM chunks"),
    env.DB.prepare("DELETE FROM documents"),
  ]);
  for (const [id, text] of [
    ["rust", "Rust async runtimes schedule futures"],
    ["garden", "Gardening for balconies"],
  ]) {
    await env.DB.prepare(
      "INSERT INTO documents (id, canonical_url, url, title, markdown_key, extract_status) VALUES (?, ?, ?, ?, ?, 'ok')",
    )
      .bind(id, `https://example.com/${id}`, `https://example.com/${id}`, id, `md/${id}.md`)
      .run();
    await env.DB.prepare(
      "INSERT INTO saves (id, source, source_id, document_id, saved_at, folder) VALUES (?, 'chrome', ?, ?, '2026-10-01T00:00:00Z', 'Reading')",
    )
      .bind(id, id, id)
      .run();
    await env.BUCKET.put(`md/${id}.md`, `# ${id}\n\n${text}`);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO chunks (id, document_id, idx, heading, text, embedding_model) VALUES (?, ?, 0, 'Overview', ?, 'test')",
      ).bind(`test:${id}:0`, id, text),
      env.DB.prepare("INSERT INTO chunks_fts (chunk_id, document_id, text, title) VALUES (?, ?, ?, ?)").bind(
        `test:${id}:0`,
        id,
        text,
        id,
      ),
    ]);
  }
});

function mockRetrieval(ids: string[]) {
  vi.spyOn(env.AI, "run").mockResolvedValue({
    data: [Array<number>(1024).fill(0.1)],
  });
  return vi.spyOn(env.VECTORS, "query").mockResolvedValue({
    count: ids.length,
    matches: ids.map((id) => ({ id, score: 0.9 })),
  });
}

describe("search", () => {
  it.each([
    ["scheduling", ["test:rust:0"]],
    ['title:gardening* "', ["test:garden:0"]],
    ["AND OR NOT", []],
    ["!!!", []],
  ])("executes safe stemmed FTS for %j", async (query, expected) => {
    const hits = await ftsSearch(env.DB, query, 10);
    expect(hits).toEqual(expected);
  });

  it("fuses both rankings, skips orphan vectors, and returns one passage per document with save history", async () => {
    await env.DB.prepare(
      "INSERT INTO chunks (id, document_id, idx, text, embedding_model) VALUES ('test:rust:1', 'rust', 1, 'Another passage', 'test')",
    ).run();
    const vectors = mockRetrieval(["test:missing:0", "test:garden:0", "test:rust:1", "test:rust:0"]);
    const hits = await hybridSearch(env, "async", 2);
    expect(hits.map((hit) => hit.document_id)).toEqual(["rust", "garden"]);
    expect(hits[0]).toMatchObject({
      url: "https://example.com/rust",
      heading: "Overview",
      text: "Rust async runtimes schedule futures",
      saves: [
        {
          source: "chrome",
          saved_at: "2026-10-01T00:00:00Z",
          folder: "Reading",
        },
      ],
    });
    expect(vectors).toHaveBeenCalledWith(Array(1024).fill(0.1), {
      namespace: "test",
      topK: 20,
    });
    const limited = await hybridSearch(env, "async", 1);
    expect(limited.map((hit) => hit.document_id)).toEqual(["rust"]);
  });

  it("returns no documents when neither retriever has a stored match", async () => {
    mockRetrieval(["test:missing:0"]);
    const hits = await hybridSearch(env, "unfindable", 8);
    expect(hits).toEqual([]);
  });

  it("reads markdown and save history, caps long documents, and distinguishes missing content", async () => {
    const doc = await getDocument(env, "rust");
    expect(doc).toMatchObject({
      id: "rust",
      markdown: "# rust\n\nRust async runtimes schedule futures",
      truncated: false,
      saves: [{ folder: "Reading" }],
    });
    await env.BUCKET.put("md/rust.md", "x".repeat(40_001));
    const long = await getDocument(env, "rust");
    expect(long?.markdown).toHaveLength(40_000);
    expect(long?.truncated).toBe(true);
    await env.BUCKET.delete("md/rust.md");
    const missingBody = await getDocument(env, "rust");
    expect(missingBody).toMatchObject({ markdown: null, truncated: false });
    const missing = await getDocument(env, "unknown");
    expect(missing).toBeNull();
  });
});

async function rpc(method: string, params?: unknown) {
  const response = await exports.default.fetch(
    new Request("https://magpie.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-mcp-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.startsWith("{")
    ? body
    : body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
  return JSON.parse(data ?? "null");
}

describe("MCP transport", () => {
  it("initializes, lists tools, searches, and reads a document through authenticated HTTP", async () => {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.result.serverInfo.name).toBe("magpie");
    const listed = await rpc("tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["get_document", "search"]);
    mockRetrieval(["test:rust:0"]);
    const searched = await rpc("tools/call", {
      name: "search",
      arguments: { query: "async" },
    });
    expect(JSON.parse(searched.result.content[0].text)[0].document_id).toBe("rust");
    const document = await rpc("tools/call", {
      name: "get_document",
      arguments: { id: "rust" },
    });
    expect(JSON.parse(document.result.content[0].text).markdown).toContain("Rust async");
  });

  it("reports missing documents and rejects invalid search limits and blank queries", async () => {
    const missing = await rpc("tools/call", {
      name: "get_document",
      arguments: { id: "unknown" },
    });
    expect(missing.result.isError).toBe(true);
    for (const args of [{ query: "async", limit: 0 }, { query: "async", limit: 21 }, { query: "  " }]) {
      const invalid = await rpc("tools/call", {
        name: "search",
        arguments: args,
      });
      expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    }
  });
});
