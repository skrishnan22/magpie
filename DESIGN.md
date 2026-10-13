# magpie — design decisions

Personal knowledge base: collect saves from X and Chrome, extract + embed content,
query it from coding agents over MCP. Built on Cloudflare, within the existing $5 Workers Paid plan.

Status: design complete (grilling session, 2026-10-13). Next: M0 + M1.

## Decided

### Interface
- Primary interface is a **remote MCP server** (streamable HTTP) for Claude Code, Codex, T3 Code.
- Auth: **bearer tokens**, no OAuth in v1.
  - `INGEST_TOKEN` — Chrome extension, can only `POST /ingest`.
  - `MCP_TOKEN` — agents, search/read + `save_url` / `sync_now`.
- v1 tools: `search`, `get_document`, `recent_saves`, `sync_now`, `save_url`.

### Budget
- Ceiling: existing $5/mo Workers Paid. Expected usage stays within included allowances.
- Corpus size: ~186 Chrome bookmarks + up to ~800 X bookmarks (~1k items).
- Guardrails: daily budget counter in D1 (browser ms, AI neurons, X reads) with self-kill-switch;
  bounded retries + dead-letter state; CF billing notifications on; **X auto-recharge OFF**.

### Sources
- **X bookmarks**: `GET /2/users/{id}/bookmarks`, owned read @ $0.001/resource.
  - One-time backfill (~800 cap, ~$0.80), then cron at **01:00 and 13:00 UTC**
    (same UTC day → dedup), `max_results=20`, stop at first known id.
  - Request `tweet.fields=note_tweet` for long posts.
  - Always request expansions (verified free in M0).
  - Threads: v2 (search by `conversation_id` is 7-day-only / $0.005 per post; or extension DOM capture).
- **Chrome bookmarks**: MV3 extension — `getTree()` backfill + `onCreated` live sync;
  later a "Save to KB" button for pages without bookmarking.

### X auth
- **OAuth 1.0a user context** (verified in M0 spike: `GET /2/users/{id}/bookmarks` → 200).
  Consumer key/secret + access token/secret for @krishships, stored as `wrangler secret`s.
- Access tokens don't expire → **no refresh/rotation logic**. User id = prefix of the access token.
- App owned by the same account (owned-read pricing). 401 → surface `x_auth_status = 'needs_login'` via MCP.
- Rate limit observed: 180 req / 15 min.

### X API facts (M0 spike, 2026-10-13)
- Results ordered by **bookmark time** (newest first), not post time. No `bookmarked_at` returned →
  `saved_at` = first time we see it. "Stop at first known id" works.
- `note_tweet` returns full long-post text. `entities.urls[].expanded_url` already resolves t.co.
- Expansions (`author_id,referenced_tweets.id,attachments.media_keys`) are **not billed**: two calls
  (plain + expanded, same 10 posts, same UTC day) cost $0.01 total → only the 10 owned reads were charged.
  → Always request expansions.

### Content extraction (fallback chain)
1. Extension-captured DOM (at save time)
2. Worker `fetch` + Readability / Workers AI `toMarkdown` (also PDFs)
3. Browser Run **Kitesurf** (free beta)
4. Browser Run Chromium (10 browser-hours/mo included)

Fall back when extracted text is empty / < ~500 chars. Store raw HTML + extracted markdown in R2.
v1 content types: articles, PDFs, GitHub READMEs. v2: YouTube transcripts, thread unroll, images.

### Data model
- `documents` — deduped by canonical URL (strip utm_*, resolve t.co).
- `saves` — (source, source_id, saved_at, note/tweet text, document_id). Same article from X + Chrome = 1 document, 2 saves.
- `chunks` — (document_id, idx, vector_id, embedding_model).

### Retrieval
- Embeddings: Workers AI **`qwen3-embedding-0.6b`** (1024d); fallback `bge-m3`.
- Chunking by length, not source: < ~500 tokens → 1 vector; else 512 tokens / 15% overlap,
  each chunk prefixed with `title — heading`.
- **Hybrid search**: D1 FTS5 (BM25) + Vectorize, merged with reciprocal rank fusion. No reranker in v1.
- Images (later): vision LLM caption/OCR → same text embedding space.
- Later milestone: **eval harness** (~30 golden queries, recall@5) to tune chunk size / overlap /
  contextual-retrieval prefix / model.

### Architecture
- **One Worker deployment** with multiple entrypoints:
  `fetch` (`/mcp`, `/ingest`), `scheduled` (X sync), `IngestWorkflow` (fetch → extract → chunk → embed → upsert),
  `McpAgent` Durable Object. Bindings: D1, R2, Vectorize, AI, BROWSER.
- Not using: Basin Pipelines/Catalog (analytics-scale, overkill), AI Search (less control), Queues (Workflows suffices).

### Repo
```
apps/worker/      single Worker
apps/extension/   Chrome MV3 extension
packages/core/    schema types, chunker, URL canonicalizer (unit-tested in Node)
scripts/backfill/ one-off X + Chrome backfill
scripts/eval/     retrieval eval harness
```
TypeScript, pnpm workspaces.

### Dev & testing
- **Single environment** (personal project). `wrangler dev`: local D1/R2, remote AI + Vectorize.
- Local runs write vectors to Vectorize **namespace `dev`** to avoid orphaning prod search results.
- Vitest for `packages/core`; `@cloudflare/vitest-pool-workers` for a few Worker integration tests.
- D1 migrations as SQL files via `wrangler d1 migrations`.

### Observability (v1)
- D1 is source of truth: documents carry `extract_status` (`pending|ok|thin|failed|dead_letter`),
  `extract_method` (`dom|readability|kitesurf|chromium`), `error`, `attempts`.
- MCP `status` tool: counts by status, recent failures, X auth state, today's budget counters.
- Workers Logs + Workflows dashboard for debugging. No alerting; dashboard / weekly digest later.

## Milestones
- **M0 — X spike**: `x-auth` + `max_results=10` pull with/without expansions; check `/2/usage/tweets`.
  Verify: 800 cap, expansion billing, `note_tweet`, owned-read rate.
- **M1 — Skeleton e2e (Chrome only)**: Worker, D1 schema, `/ingest`, IngestWorkflow, Vectorize + FTS5,
  MCP `search` / `get_document`; backfill 186 bookmarks from local `Bookmarks` JSON.
  Done = Claude Code answers from bookmarks.
- **M2 — X sync**: backfill, cron, token rotation, `sync_now`, `recent_saves`.
- **M3 — Chrome extension**: live `onCreated` + "Save to magpie" with DOM capture.
- **M4 — Extraction fallbacks**: Kitesurf → Browser Run, PDFs, GitHub READMEs, budget kill-switch.
- **M5 — Eval harness**: golden queries + chunking sweep.
- Later: images, YouTube, threads, OAuth.

## Open questions
- X ~800 bookmark cap: verify during M2 backfill.
