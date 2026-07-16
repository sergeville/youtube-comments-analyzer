# Neo4j 3D View — fitted to the YCA website

> Companion to [`PlanForNeo4j3dView.md`](../PlanForNeo4j3dView.md). That plan is sound in
> principle but written for a **Next.js / React / TypeScript / official-driver** app with
> Synapse/Archon domain concepts. YCA is the opposite: a **zero-dependency vanilla Node.js
> HTTP server** (`scripts/server.mjs`) that renders HTML strings, talks to Neo4j over the
> **HTTP `/tx/commit` endpoint** (`neo4j-lib.mjs`), and has a **YouTube** domain. This doc
> translates the plan onto YCA's actual architecture so it can ship inside the current site.

## 1. The core idea transfers; the stack does not

The single most important rule in the plan — **progressive loading, never dump the whole
graph** — is *more* true for YCA than for the plan's authors assumed. The live graph today:

| | count |
|---|---|
| Total nodes | ~27,000 |
| YouTubeComment | 7,638 · YouTubeAuthor 5,904 · YouTubeVideo 4,073 |
| Concept | 1,070 · Paragraph 715 · Chapter 23 |
| CommentContext 132 · CommentCategory 25 · YouTubeChannel 13 |
| Relationships | 16 types; WROTE/HAS_COMMENT/IN_CATEGORY/IN_CONTEXT 7,638 each; MENTIONS 2,198; NEXT 714 |

A single video's mindmap alone is ~1,800 nodes — already past Neo4j Browser's 300-node cap.
So the overview + expand-on-demand design is exactly right; only the implementation changes.

## 2. Stack translation (plan → YCA)

| Plan says | YCA uses instead | Why |
|---|---|---|
| Next.js / React / TypeScript | **One `/graph/3d` route in `server.mjs`** serving a static HTML page | No build step, no framework in this repo |
| `react-force-graph-3d` | **`3d-force-graph`** (same author, vanilla JS) via **CDN `<script>`** | Same Three.js/WebGL engine, no React, matches YCA's CDN-in-HTML pattern |
| Zustand / TanStack Query | Plain JS module state + `fetch` | No deps; graph state is small |
| Tailwind | The inline `<style>` already in `server.mjs` | Consistent with existing pages |
| Official `neo4j-driver` (Bolt) | **`neo4j-lib.mjs` `cypher()`/`cypherRows()` (HTTP)** | Already present, zero-dep, loopback-safe |
| `/src/app/...`, `route.ts` files | Handlers in `server.mjs` + a couple of small helpers | Repo has no `src/`, no TS |
| Synapse/Archon labels (Project, Sprint, Task, Agent…) | **YCA labels** (below) | Different domain |

**Net: add ~1 HTML page + ~5 read-only JSON endpoints to `server.mjs`, backed by
parameterized Cypher through the existing HTTP lib. No new npm dependencies.**

## 3. Visual registry — real YCA labels

Replace the plan's §9 registry with YCA's actual node types:

```js
const NODE_STYLES = {
  YouTubeChannel:  { group: "channel",  size: 16, shape: "sphere" },
  YouTubeVideo:    { group: "video",    size: 13, shape: "sphere" },
  Chapter:         { group: "chapter",  size: 10, shape: "box" },
  Paragraph:       { group: "paragraph",size: 6,  shape: "box" },
  Concept:         { group: "concept",  size: 7,  shape: "diamond" },   // the mindmap bridges
  YouTubeComment:  { group: "comment",  size: 5,  shape: "sphere" },
  YouTubeAuthor:   { group: "author",   size: 6,  shape: "octahedron" },
  CommentCategory: { group: "category", size: 9,  shape: "box" },
  CommentContext:  { group: "context",  size: 8,  shape: "diamond" },
};
// color by group, but also vary shape/size — never color alone (plan §9, kept).
```

Two natural "sub-graphs" the UI should let you pick between (they barely overlap):
- **Document mindmap:** `Video → Chapter → Paragraph → Concept` (+ `NEXT`) — the new work.
- **Audience graph:** `Video → Comment ← Author`, `Comment → Category/Context` — the original analyzer graph.

## 4. Endpoints — mapped to `server.mjs`

Read-only, parameterized, loopback-only (no browser credentials — `neo4j-lib` already keeps
them server-side). GET reads don't need the POST mutation token.

| Plan endpoint | YCA route | Cypher (via `cypherRows`) |
|---|---|---|
| `/api/graph/schema` | `GET /api/graph/schema` | `CALL db.labels()` counts + rel-type counts |
| `/api/graph/overview` | `GET /api/graph/overview?videoId=&labels=&limit=` | video-scoped `Video→Chapter→Paragraph` (+ optional Concept), **cap 300** |
| `/api/graph/node/:id` | `GET /api/graph/node?id=` | `MATCH (n {id:$id}) RETURN n` + rel summary |
| `/api/graph/node/:id/neighbors` | `GET /api/graph/neighbors?id=&limit=100&depth=1` | one-hop `MATCH (n{id})-[r]-(m)` |
| `/api/graph/search` | `GET /api/graph/search?q=` | the ranked search we already built (paragraph text + `MENTIONS` concept), generalized |
| `/api/graph/path` | `POST /api/graph/path` | `shortestPath((a{id})-[*..6]-(b{id}))` |
| `/api/graph/statistics` | `GET /api/graph/statistics` | label/rel counts, top-degree, orphans |

All normalize to the plan's `{nodes, links, metadata:{truncated,...}}` contract (§6), done
server-side in plain JS. **Reuse:** `neo4j-verify-document.mjs` and `graph-ask.mjs` already
contain most of these queries.

## 5. Progressive loading (unchanged, but essential here)

Keep the plan's defaults verbatim — they fit YCA's scale:
- Initial ≤ **300 nodes**, ≤ **700 relationships**; expansion ≤ **100 new nodes**; depth ≤ **2**; hard cap **5,000**.
- Overview seeds from a **chosen video** (YCA has no "active project"): Video → its 23 Chapters → Paragraphs, Concepts collapsed to a count until expanded.
- Click a Concept → expand to the paragraphs that mention it (the cross-chapter bridges).
- "Load audience graph" toggles in comments/authors on demand.

## 6. Phased scope for YCA (trimmed from the plan's 8 phases)

- **Phase A — MVP (highest value):** `/graph/3d` HTML page + `3d-force-graph` (CDN) +
  `GET /api/graph/overview` + `GET /api/graph/schema`. Renders one video's mindmap, node
  styles by label, 300-cap with a "truncated" notice. Video picker in the toolbar.
- **Phase B — Inspect + expand:** node inspector panel, click-to-expand neighbors
  (`/api/graph/neighbors`), dedupe-merge, pin/hide. Reuses `neo4j-verify-document` queries.
- **Phase C — Search + filters:** wire the existing ranked search into `/api/graph/search`,
  label/relationship checkboxes, camera focus on result.
- **Phase D — Paths + stats + audience graph:** shortest path between two nodes, status bar,
  toggle the comments/authors sub-graph, cross-video once you graph more than one.

## 7. Explicitly dropped for YCA

Not applicable to a single-user localhost YouTube tool — cut to avoid scope creep:
- Next.js/React/TS/Zustand/TanStack/Tailwind rewrite (the whole stack section).
- Synapse/Archon integration (§22), project authorization/multi-tenancy, saved per-project views.
- VR/AR, particle systems, multiplayer cursors, AI layouts, timeline/dependency/galaxy layouts
  (keep **force** + optional **hierarchy** only).
- APOC dependency — everything above is plain Cypher over the HTTP endpoint.

## 8. Security notes (already mostly satisfied)

- Credentials never reach the browser — `neo4j-lib` runs server-side; the page only calls YCA's
  JSON routes. ✅ already true.
- `neo4j-lib` refuses non-localhost non-HTTPS (`assertTlsForRemote`). ✅ already true.
- Reads are parameterized; **never** accept raw Cypher from the browser. Keep the allow-list of
  labels/relationship types on the server.
- A read-only Neo4j account is a nice hardening step but optional for local single-user use.

## 9. Recommended first commit

Build **Phase A** only: the `/graph/3d` page + `overview`/`schema` endpoints, scoped to one
video's mindmap. It's self-contained, needs no new dependencies, and immediately beats the
Neo4j Browser 300-node wall for the graph you're already exploring. Everything else layers on
top without rework.
