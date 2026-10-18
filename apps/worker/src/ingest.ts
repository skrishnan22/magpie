import { canonicalizeUrl, documentId } from "@magpie/core";
import { z } from "zod";

const SaveSchema = z.object({
  source: z.literal("chrome"),
  source_id: z.string().min(1).max(200),
  url: z.string().min(1).max(4096),
  title: z.string().max(1000).optional(),
  saved_at: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value).toISOString())
    .optional(),
  folder: z.string().max(500).optional(),
});
const IngestBody = z.object({ items: z.array(SaveSchema).min(1).max(100) });
type SaveInput = z.infer<typeof SaveSchema>;
interface RecordResult {
  newDocumentIds: string[];
  pendingDocumentIds: string[];
  saves: number;
  skipped: { source_id: string; url: string; reason: string }[];
}

async function recordSaves(db: D1Database, items: SaveInput[]): Promise<RecordResult> {
  const skipped: RecordResult["skipped"] = [];
  const statements: D1PreparedStatement[] = [];
  const saveIds = new Set<string>();
  for (const item of items) {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(item.url);
    } catch (error) {
      skipped.push({
        source_id: item.source_id,
        url: item.url,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const id = await documentId(canonical);
    const saveId = `${item.source}:${item.source_id}`;
    saveIds.add(saveId);
    // Each document/save pair runs in order in one transaction, including repeated source IDs.
    statements.push(
      db
        .prepare(
          `INSERT INTO documents (id, canonical_url, url, title)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM saves WHERE id = ?)
         ON CONFLICT(id) DO NOTHING RETURNING id`,
        )
        .bind(id, canonical, item.url, item.title ?? null, saveId),
      db
        .prepare(
          `INSERT INTO saves (id, source, source_id, document_id, saved_at, title, folder)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, source_id) DO NOTHING RETURNING id`,
        )
        .bind(
          saveId,
          item.source,
          item.source_id,
          id,
          item.saved_at ?? new Date().toISOString(),
          item.title ?? null,
          item.folder ?? null,
        ),
    );
  }
  if (!statements.length) return { newDocumentIds: [], pendingDocumentIds: [], saves: 0, skipped };

  const results = await db.batch<{ id: string }>([
    ...statements,
    db
      .prepare(
        `SELECT DISTINCT d.id FROM documents d JOIN saves s ON s.document_id = d.id
       WHERE s.id IN (${[...saveIds].map(() => "?").join(",")}) AND d.workflow_started = 0`,
      )
      .bind(...saveIds),
  ]);
  const inserts = results.slice(0, -1);
  return {
    newDocumentIds: inserts
      .filter((_, i) => i % 2 === 0)
      .flatMap((result) => result.results.map((row) => row.id)),
    saves: inserts.filter((_, i) => i % 2 === 1).reduce((count, result) => count + result.results.length, 0),
    pendingDocumentIds: results.at(-1)!.results.map((row) => row.id),
    skipped,
  };
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = IngestBody.safeParse(json);
  if (!parsed.success)
    return Response.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });

  const result = await recordSaves(env.DB, parsed.data.items);
  const pending = result.pendingDocumentIds;
  let failedToStart: string[] = [];
  if (pending.length) {
    let started: string[] = [];
    try {
      const batch = await env.INGEST.createBatch({
        instances: pending.map((id) => ({ id: `ingest-${id}`, params: { documentId: id } })),
      });
      // An existing deterministic ID also confirms dispatch after a lost response or concurrent retry.
      const failed = new Set(
        batch.errors.filter((error) => error.code !== 10405).map((error) => error.index),
      );
      started = pending.filter((_, i) => !failed.has(i));
      failedToStart = pending.filter((_, i) => failed.has(i));
    } catch {
      failedToStart = pending;
    }
    if (started.length) {
      await env.DB.prepare(
        `UPDATE documents SET workflow_started = 1 WHERE id IN (${started.map(() => "?").join(",")})`,
      )
        .bind(...started)
        .run();
    }
  }
  return Response.json({
    saves: result.saves,
    new_documents: result.newDocumentIds.length,
    failed_to_start: failedToStart,
    skipped: result.skipped,
  });
}
