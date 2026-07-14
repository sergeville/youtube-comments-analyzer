# Neo4j integration — youtube-comments-analyzer

This tool imports classified YouTube comments into a local **Neo4j 5-community**
database and verifies the result. It is a **standalone local tool** — it is *not* a
Synapse runtime service and does *not* share a database with Archon.

> **Scope boundary (important):** Neo4j here holds the **YouTube comment domain only**.
> Synapse's project/task knowledge graph and agent memory live in **Postgres/Supabase**
> (Archon `kg_nodes`/`kg_edges` + RAG), by a deliberate architecture decision
> (`docs/NEXLIFY_E4-0_KG_SPIKE_DECISION.md`). Do not mix the two. See
> [`data-model.md`](./data-model.md) and [`security.md`](./security.md).

## Local setup

1. Copy env and set a password:
   ```bash
   cp .env.example .env
   # edit .env: set NEO4J_PASSWORD
   ```
2. Start Neo4j (Docker):
   ```bash
   npm run neo4j:up          # docker compose up -d
   ```
   Neo4j Browser: http://localhost:7474 · Bolt: bolt://localhost:7687
3. Import a generated comments JSON:
   ```bash
   npm run dry-run:neo4j                                   # validate, no writes
   npm run neo4j:import -- output/<videoId>.comments.json  # write
   npm run neo4j:verify                                    # counts
   npm run neo4j:down                                      # stop
   ```
4. Preview or apply context relations for comments already in Neo4j:
   ```bash
   npm run context:dry -- --limit 25  # read-only preview; no schema or graph writes
   npm run context:write              # explicit full-graph, resumable/idempotent write
   ```

## Environment variables

| Variable | Purpose | Local default |
|---|---|---|
| `NEO4J_URL` | Neo4j HTTP endpoint. Non-localhost **must** be `https://`. | `http://localhost:7474` |
| `NEO4J_DATABASE` | Database name | `neo4j` |
| `NEO4J_USER` | Username | `neo4j` |
| `NEO4J_PASSWORD` | Password (also `NEO4J_AUTH` in `docker-compose.yml`) | — (set it) |

Values are read from the environment first, then from `.env`. `.env` is **gitignored** —
never commit real credentials.

## How it works

- Uses the Neo4j **legacy HTTP transactional endpoint** `POST /db/{database}/tx/commit`
  with `fetch` + Basic auth. No language driver, no persistent connection.
- All Cypher is **parameterized**. Writes use `MERGE` with `IF NOT EXISTS` uniqueness
  constraints on business keys, so imports are idempotent.
- Import is batched (200 rows/statement).
- Comment context is classified during normal extraction and stored at
  `evaluation.context`; normal import projects it automatically.
- Legacy JSON derives the same context in memory. Existing graph data uses the
  dry-run-first context backfill shown above.
- `--limit` is preview-only. Writes always inspect the complete graph before
  refreshing aggregates and refuse to start if any comment row is invalid.

## Context relation labels

Context uses stable Neo4j types: `IN_CONTEXT`, `SUBCLASS_OF`, `VALID_FOR`,
`COVERS`, and `DISCUSSES`. The human-readable one-to-three-word relation name is
the `IN_CONTEXT.label` property and is also `CommentContext.name`.

For example, this edge may be displayed as **Setup Question**:

```cypher
MATCH (comment:YouTubeComment)-[relation:IN_CONTEXT]->(context:CommentContext)
RETURN comment.text, relation.label, context.name;
```

The label is deliberately not used as a relationship type. Creating dynamic
types from comment text would expand the graph schema and make queries brittle.

Useful aggregate traversals:

```cypher
MATCH (video:YouTubeVideo)-[coverage:COVERS]->(context:CommentContext)
RETURN video.title, context.name, coverage.commentCount, coverage.share
ORDER BY coverage.commentCount DESC;

MATCH (author:YouTubeAuthor)-[discussion:DISCUSSES]->(context:CommentContext)
RETURN author.handle, context.name, discussion.commentCount
ORDER BY discussion.commentCount DESC;
```

## Data model

See [`data-model.md`](./data-model.md). Constraints/indexes are applied by the schema
file (`scripts/neo4j-schema.cypher`) and, for backward compatibility, on import.

## Aura / remote

Point `NEO4J_URL` at an `https://` Aura HTTP endpoint and set credentials via the
environment (not `.env`) — see [`security.md`](./security.md). The scripts reject a
non-localhost `NEO4J_URL` that is not `https://`.

## Safe shutdown & data

`npm run neo4j:down` stops the container; data persists in the `neo4j-data` Docker
volume. To wipe: `docker compose down -v`.

## Future work (not in this story)

- Migrate from the legacy `tx/commit` endpoint to the Neo4j **Query API**
  `/db/{database}/query/v2` (legacy is maintenance-only past Neo4j 5.26 LTS).
- Optional `neo4j-driver` (npm) adoption for pooling/retries.
- Optional read-only MCP surface (`mcp-neo4j-cypher`, `NEO4J_READ_ONLY=true`,
  non-prod) — would be a separate story.
