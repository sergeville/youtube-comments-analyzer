# Neo4j data model — youtube-comments-analyzer

The graph holds the **YouTube comment domain only**. Identifiers are **stable business
keys** (YouTube ids / classifier names) — never Neo4j internal node ids.

## Nodes

| Label | Unique key | Required | Optional | Constraint |
|---|---|---|---|---|
| `YouTubeVideo` | `id` | `id`, `title` | `url`, `reportedCommentCount`, `extractedCommentCount`, `updatedAt` | `REQUIRE v.id IS UNIQUE` |
| `YouTubeComment` | `id` | `id`, `text` | `likeCount`, `parent`, `isPinned`, `isCreator`, `timestamp`, `category`, `intent`, `sentiment`, `priority`, `reasons`, `updatedAt` | `REQUIRE c.id IS UNIQUE` |
| `YouTubeAuthor` | `id` (author key) | `id` | `handle`, `youtubeAuthorId`, `url`, `updatedAt` | `REQUIRE a.id IS UNIQUE` |
| `CommentCategory` | `name` | `name` | — | `REQUIRE cat.name IS UNIQUE` |
| `ClassificationProfile` | `name` | `name` | — | `REQUIRE p.name IS UNIQUE` |
| `CommentContext` | `key` | `key`, `name`, `mode`, `classifierVersion`, `category`, `profile` | `updatedAt` | `REQUIRE ctx.key IS UNIQUE` |

`YouTubeAuthor.id` is `authorId || author || "unknown-author"` (the import's `authorKey`).

## Relationships

| Pattern | Meaning |
|---|---|
| `(:YouTubeVideo)-[:HAS_COMMENT]->(:YouTubeComment)` | comment belongs to video |
| `(:YouTubeAuthor)-[:WROTE]->(:YouTubeComment)` | authorship |
| `(:YouTubeComment)-[:REPLY_TO]->(:YouTubeComment)` | reply threading (child → parent) |
| `(:YouTubeComment)-[:IN_CATEGORY]->(:CommentCategory)` | classification bucket |
| `(:YouTubeVideo)-[:USES_CLASSIFICATION_PROFILE]->(:ClassificationProfile)` | which profile classified this video |
| `(:YouTubeComment)-[:IN_CONTEXT]->(:CommentContext)` | one current contextual classification per comment |
| `(:CommentContext)-[:SUBCLASS_OF]->(:CommentCategory)` | context belongs to its broad category |
| `(:CommentContext)-[:VALID_FOR]->(:ClassificationProfile)` | context belongs to the profile that produced it |
| `(:YouTubeVideo)-[:COVERS]->(:CommentContext)` | video context totals and share |
| `(:YouTubeAuthor)-[:DISCUSSES]->(:CommentContext)` | author context totals across imported comments |

All relationships are created with `MERGE`, so re-import is idempotent.

`IN_CONTEXT` stores `label`, `mode`, and `classifierVersion`. Its `label` is the
same one-to-three-word value as `CommentContext.name`, such as `Setup Question`
or `Site Safety Advice`. Consumers should display `IN_CONTEXT.label` as the edge
caption. The relationship type remains the stable `IN_CONTEXT`; context text is
never converted into a dynamic Neo4j relationship type.

`COVERS` stores `commentCount`, `share`, and `updatedAt`. `DISCUSSES` stores
`commentCount` and `updatedAt`. Imports delete and recalculate these bounded
aggregate edges for the affected video and authors, so repeated imports do not
increase counts.

## Context extraction

New extraction writes this deterministic object before the comments JSON and
HTML report are created:

```json
{
  "name": "Setup Question",
  "mode": "Question",
  "classifierVersion": "yca-context-v1"
}
```

It lives at `comment.evaluation.context`. The classifier combines the broad
category subject with one controlled mode and validates the result as one to
three ASCII words. It is local and does not use Ollama or a remote API.

Legacy JSON without `evaluation.context` remains importable: the same context is
derived in memory. A stored context object that is malformed or outside the
controlled vocabulary is rejected with its comment id instead of silently
entering the graph.

## Indexes

Range indexes (added by `scripts/neo4j-schema.cypher`) support the verify aggregations:

- `YouTubeComment.category` — the `IN_CATEGORY` count-by-category query.
- `YouTubeComment.parent` — root-vs-reply partitioning.

## Schema versioning

A single `(:SchemaVersion {name:'youtube-comments', version:3, appliedAt:datetime()})`
node tracks the applied schema. The schema file is idempotent (`IF NOT EXISTS`) and safe
to re-run.

## Retention & source of truth

- **Generated report source of truth:** the generated `output/<videoId>.comments.json`
  files remain the durable source for full extracted comment reports and regenerated
  HTML/document/mind-map artifacts.
- **Dashboard graph inventory:** when Neo4j is configured and reachable, the dashboard
  also treats the graph as the source for channel/video inventory. It reads
  `(:YouTubeChannel)-[:PUBLISHED]->(:YouTubeVideo)` relationships so graph-only videos
  remain visible even when no local `output/<videoId>.comments.json` exists yet.
- **Rebuildability:** Neo4j is still a local derived projection for comment data. Dropping
  the volume removes graph inventory as well as imported comments, so only wipe it when
  the graph is disposable or backed by recoverable channel/output artifacts.
- **Retention:** local/dev only; no retention policy enforced. Wipe with
  `docker compose down -v`.
