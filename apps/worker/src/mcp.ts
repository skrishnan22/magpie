import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getDocument, hybridSearch } from "./search";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "magpie", version: "0.1.0" });

  server.registerTool(
    "search",
    {
      description:
        "Search the user's personal knowledge base (saved Chrome bookmarks and, later, X bookmarks). " +
        "Hybrid keyword + semantic search; returns the best-matching passage per document with its URL and when/where it was saved. " +
        "Use get_document for the full text of a hit.",
      inputSchema: {
        query: z.string().trim().min(1).describe("What to look for, in natural language or keywords"),
        limit: z.number().int().min(1).max(20).optional().describe("Max documents to return (default 8)"),
      },
    },
    async ({ query, limit }) => {
      const hits = await hybridSearch(env, query, limit ?? 8);
      return json(hits);
    },
  );

  server.registerTool(
    "get_document",
    {
      description: "Fetch a saved document's full extracted markdown (truncated at 40k chars) and its save history.",
      inputSchema: {
        id: z.string().describe("document_id from a search result"),
      },
    },
    async ({ id }) => {
      const doc = await getDocument(env, id);
      return doc ? json(doc) : { ...json({ error: `no document ${id}` }), isError: true };
    },
  );

  return server;
}
