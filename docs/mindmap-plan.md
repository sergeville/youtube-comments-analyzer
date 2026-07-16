# Plan — Document → Chapters → Paragraphs → Context → Neo4j Mindmap

> Status: **PROPOSED** (plan only, no code yet)
> Author: Claude (Opus 4.8) · Date: 2026-07-16
> Reference document: `http://127.0.0.1:4478/document/1mvlBz6pj1I`
> Video: `1mvlBz6pj1I` — "How To Build Your Own RAG AI System - Better Results Than Claude" (Web Dev Simplified, 23 chapters)

## Goal

From an analyzed video document, extract **all chapters**, and within each chapter **all
paragraphs**, attach the **context** of each paragraph, and build a **mindmap in Neo4j** that
can be explored in Neo4j Browser.

## Chosen options (approved 2026-07-16)

| Decision | Choice |
|---|---|
| Paragraph context depth | **Both** — structural (deterministic) + Ollama `llama3.2` semantic |
| Mindmap view | **Neo4j Browser** saved Cypher queries (no new UI) |
| Delivery | **Plan doc first** (this file), then implement on a branch after review |

## What already exists (reuse — do not rebuild)

- `scripts/document-tool.mjs` → exports **`buildSections(paragraphs, chapters, duration)`**,
  which already folds the transcript into the video's 23 chapters. Each section is
  `{ title, start, end, text, paras[] }`. **This is the chapter→paragraph extraction.**
- `scripts/transcript-tool.mjs` → `parseJson3`, `groupParagraphs`, `paragraphize`, `formatTimestamp`.
- `scripts/neo4j-lib.mjs` → `cypher`, `cypherRows`, `resolveConfig`, `ensureSchema`,
  `SCHEMA_STATEMENTS`, `SCHEMA_VERSION`.
- `scripts/neo4j-import-youtube-comments.mjs` → template for a new document importer (idempotent MERGE pattern).
- `scripts/mindmap-tool.mjs` → existing Ollama (`llama3.2`) summarization plumbing to copy for context generation.
- Neo4j is already running: container `youtube-comments-neo4j` (healthy) on `127.0.0.1:7474` / `:7687`.

## Gap

The current graph models **comments only** (`YouTubeChannel/Video/Comment/Author/CommentCategory/…`).
There are **no `Chapter`, `Paragraph`, or `Concept` nodes**. That is the work.

## Graph model

```
(YouTubeVideo)-[:HAS_CHAPTER {index}]->(Chapter {id, title, start, end, index})
(Chapter)-[:HAS_PARAGRAPH {index}]->(Paragraph {id, text, summary, start, end, index})
(Paragraph)-[:MENTIONS]->(Concept {name})        // semantic context, shared across paragraphs
(Paragraph)-[:NEXT]->(Paragraph)                  // reading order (mindmap flow)
(Chapter)-[:NEXT]->(Chapter)
```

Node id conventions (business keys, idempotent):
- `Chapter.id`  = `<videoId>:ch:<index>`
- `Paragraph.id` = `<videoId>:ch:<chIndex>:p:<pIndex>`
- `Concept.name` = normalized lowercase concept string (shared/merged across the whole video)

Shared `Concept` nodes are what make this a **mindmap** rather than a flat outline — e.g.
"drizzle", "betterauth", "rag", "neon" thread across multiple chapters.

## Paragraph "context" — two tiers, both built

1. **Structural (deterministic, no LLM):** chapter title, timestamp range, position
   (`index N of M`), and neighbor paragraphs via `:NEXT`. Exact, fast, zero-cost.
2. **Semantic (Ollama `llama3.2`, local):** per paragraph, extract 3–5 key `Concept`s + a
   one-line `summary`. Reuses `mindmap-tool.mjs` Ollama plumbing. Gated behind `--semantic`
   so a fast structural-only run is still possible.

## Build steps

1. **Schema** — add `Chapter.id`, `Paragraph.id`, `Concept.name` uniqueness constraints to
   `scripts/neo4j-schema.cypher` **and** `SCHEMA_STATEMENTS` in `neo4j-lib.mjs`; bump
   `SCHEMA_VERSION` 3 → 4 (keep the `.cypher` file and the JS array in sync — the header says so).
2. **`scripts/document-context-tool.mjs`** (new) — input `<videoId>`: load `info.json` +
   caption `.json3`, call `buildSections()`, and for each paragraph emit structural context
   always + Ollama concepts/summary when `--semantic`. Output `output/<id>.document-graph.json`.
   Emit NDJSON progress on stderr when `YCA_PROGRESS` is set (match sibling tools).
3. **`scripts/neo4j-import-document.mjs`** (new) — `ensureSchema()`, then idempotent `MERGE`
   of Video→Chapter→Paragraph→Concept plus the `:NEXT` chains, mirroring the comments importer.
   Re-runnable without duplication.
4. **`docs/neo4j/mindmap-queries.cypher`** (new) — saved Neo4j Browser queries:
   - full mindmap for a video (Video→Chapter→Paragraph→Concept)
   - single chapter drill-down with its paragraphs + concepts
   - concept-centric view ("which chapters/paragraphs mention X")
   - cross-chapter concepts (concepts appearing in ≥2 chapters — the mindmap "bridges")
5. **`scripts/neo4j-verify-document.mjs`** (new) — assert 23 chapters, paragraph counts per
   chapter, no orphan `Paragraph`/`Concept`, `:NEXT` chains contiguous. Plus a smoke test in
   the existing test style (`*.test.mjs`).

## Acceptance criteria

- Running the pipeline on `1mvlBz6pj1I` creates exactly **23 `Chapter` nodes** linked to the video, each with its paragraphs.
- Every `Paragraph` has structural context (chapter, timestamps, index) and — with `--semantic` — ≥1 `Concept` + a `summary`.
- At least one `Concept` bridges ≥2 chapters (proves cross-linking).
- The mindmap Cypher queries render a connected graph in Neo4j Browser.
- Re-running the importer produces **no duplicate nodes** (idempotent).
- `neo4j-verify-document.mjs` passes.

## Out of scope (this pass)

- HTML mindmap page on :4478 (deferred — Cypher/Browser view chosen).
- Comments↔paragraph linking (could relate a comment to the chapter it references — future).
- Multi-video / cross-video concept graph.

## Open risks / notes

- Ollama must be running (`localhost:11434`, `llama3.2`) for `--semantic`; structural tier
  works without it. Verify before the semantic run.
- YCA is in **retirement/handoff** status (recent commits record its wind-down) — confirm this
  feature is worth adding before implementation, or scope it as the analyzer's final capability.
- Follow the repo's own workflow (branch + PR to `sergeville/youtube-comments-analyzer`); this
  is now a standalone repo, not part of the Synapse monorepo.
