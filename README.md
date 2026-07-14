# YouTube Comments Analyzer

YouTube Comments Analyzer is a local-first tool that extracts and classifies YouTube comments, builds transcript documents, optionally creates Ollama-powered mind maps, and imports structured comments and contextual relationships into Neo4j.

## What Is Included

- `scripts/youtube-comments-tool.mjs`: validates a YouTube URL, runs `yt-dlp`, normalizes comments, classifies them, and generates JSON plus HTML.
- `scripts/neo4j-import-youtube-comments.mjs`: imports a generated comments JSON file into Neo4j using the HTTP transaction API.
- `scripts/neo4j-verify-youtube-comments.mjs`: verifies Neo4j graph counts after import.
- `output/`: generated files. Only the small curated sample fixtures are intended to be tracked; new extraction output is ignored by default.

## Requirements

- Node.js 18 or newer.
- `yt-dlp` on your `PATH` for fresh YouTube extraction.
- Docker for the included local Neo4j database, or another Neo4j instance when using custom connection settings.
- Ollama is optional and is only needed for the AI-generated mind-map feature.

## Installation Procedure

### 1. Install Required Tools

On macOS with Homebrew:

```bash
brew install node yt-dlp
```

Install and start Docker Desktop. Confirm the required tools are available:

```bash
node --version
yt-dlp --version
docker --version
docker compose version
```

Ollama is optional. Install it only if you want to generate LLM-powered mind maps:

```bash
brew install ollama
ollama serve
ollama pull llama3.2:latest
```

The default mind-map model is `llama3.2:latest`. Change it with `YCA_OLLAMA_MODEL` if another local model is installed.

### 2. Configure The Project

From the project directory:

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `NEO4J_PASSWORD`. The same password is used by Docker Neo4j and by the import/verification scripts. The local defaults are:

```text
NEO4J_URL=http://localhost:7474
NEO4J_DATABASE=neo4j
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-local-password
```

`.env` is gitignored. Never commit real credentials. Remote Neo4j URLs must use `https://`.

### 3. Validate The Installation

Run the local checks before starting the application:

```bash
npm run check
npm test
```

Start the included Neo4j database and confirm its health:

```bash
npm run neo4j:up
docker compose ps
```

Neo4j Browser will be available at [http://localhost:7474](http://localhost:7474). Verify the graph connection without importing data:

```bash
npm run dry-run:neo4j
```

### 4. Start The Dashboard

Start the local dashboard in a separate terminal:

```bash
npm run serve
```

Open [http://127.0.0.1:4478](http://127.0.0.1:4478). Keep the dashboard terminal open while using the site. The dashboard binds to loopback only.

The included sample data is available immediately. To stop the dashboard, press `Ctrl-C`. Stop Neo4j when finished:

```bash
npm run neo4j:down
```

### 5. Extract And Build A Report

Paste a YouTube URL into the dashboard, or run the extraction command directly:

```bash
npm run extract -- "https://www.youtube.com/watch?v=neUqTZiFKq4"
```

Generated comments JSON and HTML are written to `output/`. Create a transcript-based document with:

```bash
npm run document -- "https://www.youtube.com/watch?v=neUqTZiFKq4"
```

The document uses YouTube captions and optional video frames. It does not require an LLM.

Generate the optional LLM-powered mind map from an existing comments file:

```bash
npm run mindmap -- output/neUqTZiFKq4.comments.json
```

This requires Ollama to be running and the configured model to be pulled.

## First-Run Troubleshooting

- **`yt-dlp: command not found`**: install it with `brew install yt-dlp`, then open a new terminal or verify that Homebrew is on your `PATH`.
- **Neo4j authentication fails after changing `.env`**: the Docker volume keeps the password from its first initialization. Do not delete the volume if it contains data. For a disposable local database only, use `docker compose down -v` and run `npm run neo4j:up` again.
- **Port `4478` is already in use**: stop the existing analyzer process or start this process with another explicit port, for example `PORT=4479 npm run serve`.
- **Ollama is unreachable**: confirm `ollama serve` is running, then check that `OLLAMA_URL` and `YCA_OLLAMA_MODEL` point to the running local model.
- **A fresh extraction fails**: confirm the URL is a public YouTube video and that the machine has network access. Existing JSON can still regenerate reports with `--from-json` without downloading again.

## Output Data Policy

Generated reports can contain public YouTube handles, author IDs, URLs, and full comment text. New files under `output/` are gitignored by default so fresh extractions do not get staged accidentally. If a sample is useful for tests or documentation, curate it deliberately and force-add only that fixture.

## Open The HTML Report

Open this file in a browser:

```text
output/neUqTZiFKq4.comments.html
```

The report includes:

- comment cards with replies
- classification mindmap
- theme lanes
- Neo4j graph database panel with counts, Browser link, and copyable Cypher queries

## Refresh HTML From Existing JSON

Use this when the report design changes but comments do not need to be downloaded again:

```bash
node scripts/youtube-comments-tool.mjs --from-json output/neUqTZiFKq4.comments.json
```

## Validate Neo4j Import Without Writing

```bash
npm run dry-run:neo4j
```

Or specify any generated comments JSON:

```bash
npm run neo4j:import -- output/neUqTZiFKq4.comments.json --dry-run
```

## Start Local Neo4j

```bash
npm run neo4j:up
```

Neo4j Browser will be available at:

```text
http://localhost:7474
```

## Import Into Neo4j

```bash
npm run neo4j:import -- output/neUqTZiFKq4.comments.json
```

Optional settings:

```bash
NEO4J_URL=http://localhost:7474
NEO4J_DATABASE=neo4j
```

Local defaults are stored in `.env`.

## Verify Neo4j Counts

```bash
npm run neo4j:verify
```

To stop the local database:

```bash
npm run neo4j:down
```

## Graph Model

```text
(:YouTubeVideo)-[:HAS_COMMENT]->(:YouTubeComment)
(:YouTubeAuthor)-[:WROTE]->(:YouTubeComment)
(:YouTubeComment)-[:REPLY_TO]->(:YouTubeComment)
(:YouTubeComment)-[:IN_CATEGORY]->(:CommentCategory)
(:YouTubeVideo)-[:USES_CLASSIFICATION_PROFILE]->(:ClassificationProfile)
```

## Neo4j Documentation

Deeper Neo4j docs live in [`docs/neo4j/`](docs/neo4j/):

- [`README.md`](docs/neo4j/README.md) — setup, env vars, how it works, Aura/remote
- [`data-model.md`](docs/neo4j/data-model.md) — nodes, relationships, constraints, indexes
- [`security.md`](docs/neo4j/security.md) — credentials, TLS rule, query safety, how to disable writes

Copy `.env.example` to `.env` and set `NEO4J_PASSWORD` before importing. `.env` is
gitignored — never commit real credentials. A non-localhost `NEO4J_URL` must be `https://`.

## Tests

```bash
npm run check   # syntax
npm test        # unit tests (no live database needed)
```

## Notes

This folder is intentionally standalone. It is not registered as a Synapse runtime service.

Neo4j here holds the **YouTube comment domain only**. Synapse's project/task knowledge
graph and agent memory live in Postgres/Supabase (Archon), by design — see
`docs/neo4j/README.md`.
