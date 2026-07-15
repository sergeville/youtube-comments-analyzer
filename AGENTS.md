# YouTube Comments Analyzer

## Project identity

YouTube Comments Analyzer (YCA) is a standalone, local-first application for extracting YouTube comments and transcripts, classifying discussion, generating documents, and storing comment relationships in Neo4j.

## Source of truth

- Repository: `https://github.com/sergeville/youtube-comments-analyzer.git`
- Canonical local checkout: `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`
- This project is independent of the Synapse source tree. Synapse may provide planning or operator context, but YCA code, configuration, data, and runtime are owned here.

## Scope and boundaries

- YCA owns its Node.js application, scripts, prompts, docs, local configuration, extraction artifacts, and Neo4j import/verification workflow.
- `.env` and generated output are local-only and must never be committed.
- Neo4j is optional infrastructure for the local comment graph.
- Ollama is optional. Remote or paid model APIs are not part of the default workflow.
- Do not copy Synapse source files or Synapse runtime data into this repository.

## Common commands

```bash
npm install
npm run check
npm test
npm run serve
npm run context:dry
npm run context:write
npm run neo4j:verify
```

The dashboard runs at `http://127.0.0.1:4478`. Neo4j uses `http://localhost:7474` and Bolt on `localhost:7687` when enabled. Ollama, when installed, normally uses `http://localhost:11434`.

## Operating roles

- **Archon:** active execution, task status, approvals, and validation evidence when YCA work is coordinated through Synapse.
- **Linear:** optional high-level milestone mirror only. Linear is not authoritative for execution state or technical validation.
- **GitHub:** code, issues, pull requests, and release history.
- **README and project docs:** user-facing installation and operating procedures.

Keep these roles explicit. Do not create competing task state in multiple systems.

## Working method

1. Inspect the standalone repository and current runtime state.
2. Define the bounded change and acceptance evidence.
3. Implement only the requested project-local change.
4. Run focused checks and tests.
5. Record operational evidence before claiming completion.

Ask before destructive data removal, changing the Neo4j schema, using paid or remote APIs, or publishing private artifacts.
