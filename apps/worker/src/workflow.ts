import { chunkMarkdown } from "@magpie/core";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { EMBEDDING_MODEL, embedTexts } from "./embed";
import { extractMarkdown } from "./extract";

export interface IngestParams {
  documentId: string;
}

const MAX_BYTES = 15 * 1024 * 1024;
const THIN_CHARS = 500;
const STEP_OPTIONS = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
} satisfies WorkflowStepConfig;

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const { env } = this;
    const docId = event.payload.documentId;
    let attempt = 0;

    try {
      const doc = await step.do("load", STEP_OPTIONS, async () => {
        const row = await env.DB.prepare("SELECT url, title, attempts FROM documents WHERE id = ?")
          .bind(docId)
          .first<{ url: string; title: string | null; attempts: number }>();
        if (!row) throw new NonRetryableError(`document ${docId} not found`);
        return row;
      });
      attempt = doc.attempts + 1;

      const fetched = await step.do("fetch", STEP_OPTIONS, async () => {
        const response = await fetch(doc.url, {
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; Magpie/0.1)",
            accept: "text/html,application/pdf,text/plain,text/markdown",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
          throw new NonRetryableError(`HTTP ${response.status}`);
        }
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        const body = await readBody(response);
        const rawKey = `raw/${docId}`;
        const finalUrl = response.url || doc.url;
        await env.BUCKET.put(rawKey, body, {
          httpMetadata: { contentType },
          customMetadata: { url: finalUrl },
        });
        return { rawKey, contentType, finalUrl };
      });

      const extracted = await step.do("extract", { ...STEP_OPTIONS, timeout: "2 minutes" }, async () => {
        const raw = await env.BUCKET.get(fetched.rawKey);
        if (!raw) throw new Error(`missing ${fetched.rawKey}`);
        const body = await raw.arrayBuffer();
        const result = await extractMarkdown(env.AI, body, fetched.contentType, fetched.finalUrl);
        const markdownKey = `md/${docId}.md`;
        await env.BUCKET.put(markdownKey, result.markdown, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        });
        return {
          markdownKey,
          title: result.title,
          method: result.method,
          chars: result.markdown.length,
        };
      });
      const title = extracted.title ?? doc.title ?? doc.url;

      const indexed = await step.do("index", { ...STEP_OPTIONS, timeout: "5 minutes" }, async () => {
        const stored = await env.BUCKET.get(extracted.markdownKey);
        if (!stored) throw new Error(`missing ${extracted.markdownKey}`);
        const markdown = await stored.text();
        const chunks = await chunkMarkdown(markdown, title);
        const vectors = await embedTexts(
          env.AI,
          chunks.map((chunk) => chunk.text),
        );
        const entries = chunks.map((chunk, i) => ({
          id: `${env.VECTOR_NAMESPACE}:${docId}:${chunk.idx}`,
          values: vectors[i]!,
          namespace: env.VECTOR_NAMESPACE,
          metadata: { document_id: docId, idx: chunk.idx },
        }));
        const previous = await env.DB.prepare("SELECT id FROM chunks WHERE document_id = ?")
          .bind(docId)
          .all<{ id: string }>();
        const ids = new Set(entries.map((entry) => entry.id));
        const stale = previous.results.map((row) => row.id).filter((id) => !ids.has(id));
        if (entries.length) await env.VECTORS.upsert(entries);
        if (stale.length) await env.VECTORS.deleteByIds(stale);

        await env.DB.batch([
          env.DB.prepare("DELETE FROM chunks WHERE document_id = ?").bind(docId),
          ...chunks.flatMap((chunk, i) => [
            env.DB.prepare(
              "INSERT INTO chunks (id, document_id, idx, heading, text, embedding_model) VALUES (?, ?, ?, ?, ?, ?)",
            ).bind(entries[i]!.id, docId, chunk.idx, chunk.heading, chunk.text, EMBEDDING_MODEL),
            env.DB.prepare(
              "INSERT INTO chunks_fts (text, title, chunk_id, document_id) VALUES (?, ?, ?, ?)",
            ).bind(chunk.text, title, entries[i]!.id, docId),
          ]),
        ]);
        return { chunks: chunks.length };
      });

      await step.do("finalize", STEP_OPTIONS, async () => {
        await env.DB.prepare(
          `UPDATE documents SET extract_status = ?, extract_method = ?, title = ?, raw_key = ?, markdown_key = ?,
             content_chars = ?, embedding_model = ?, error = NULL, attempts = MAX(attempts, ?),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
          .bind(
            extracted.chars < THIN_CHARS ? "thin" : "ok",
            extracted.method,
            title,
            fetched.rawKey,
            extracted.markdownKey,
            extracted.chars,
            EMBEDDING_MODEL,
            attempt,
            docId,
          )
          .run();
      });
      return { documentId: docId, chunks: indexed.chunks };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await step.do("mark-failed", STEP_OPTIONS, async () => {
        await env.DB.prepare(
          `UPDATE documents SET extract_status = 'failed', error = ?, attempts = MAX(attempts, ?),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        )
          .bind(message, attempt, docId)
          .run();
      });
      throw error;
    }
  }
}

async function readBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new NonRetryableError(`response too large: exceeds ${MAX_BYTES} bytes`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}
