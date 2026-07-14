# Neo4j security — youtube-comments-analyzer

This tool is **local-first** and standalone. The controls below keep it safe to run and
safe if ever pointed at a remote/Aura instance.

## Credentials

- Stored in `.env` (**gitignored**) or the environment. `.env.example` carries **keys
  only**, no secrets. Never commit a real `NEO4J_PASSWORD`.
- The Docker container password comes from `NEO4J_AUTH: "neo4j/${NEO4J_PASSWORD}"` in
  `docker-compose.yml` — the same `NEO4J_PASSWORD` the scripts read. Keep them in sync.
- For a remote/Aura target, prefer real environment variables (or a secret manager) over
  a `.env` file on disk.

## Transport / TLS

- **Localhost** (`localhost` / `127.0.0.1`): plain `http://` is acceptable (loopback).
- **Any other host**: `NEO4J_URL` **must** be `https://`. The import and verify scripts
  reject a non-localhost non-`https` URL with a clear error, so credentials are never
  sent over plaintext to a remote host.

## Query safety

- **Parameterized Cypher only** — no string interpolation of user/data values into Cypher.
- **Query timeout** — each HTTP request is bounded (`AbortController`); a hung Neo4j does
  not hang the tool indefinitely.
- **Result-size cap** — verify/read responses are capped to avoid unbounded payloads.
- **Idempotent writes** — `MERGE` + uniqueness constraints; re-import cannot duplicate.

## What this tool does NOT do

- No arbitrary-Cypher endpoint exposed to users or agents.
- No MCP server (no AI-agent write path to Neo4j) in this scope.
- No infrastructure management (no Aura create/scale/destroy).
- No connection to Synapse/Archon databases — the Postgres KG and RAG memory are
  untouched.

## If this ever becomes a Synapse runtime service

Escalate before that happens: move secrets to the platform secret manager, require TLS
everywhere, add rate limiting and audit logging, and separate read vs write credentials.
Those are out of scope for the current standalone local tool and are noted here so the
bar is explicit.

## Disable all writes

Run only `npm run dry-run:neo4j` (validates, never connects for writes) and
`npm run neo4j:verify` (read-only counts). Do not run `npm run neo4j:import` without the
`--dry-run` flag if writes must be prevented.
