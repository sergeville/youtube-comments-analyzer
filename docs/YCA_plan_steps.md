# YCA Standalone Plan Steps

## Purpose

This tracker records the work required to keep YouTube Comments Analyzer (YCA)
independent from the Synapse source tree while allowing controlled coordination with
Synapse tooling.

## Status

### Phase 1: Establish the standalone source of truth — complete

- [x] Standalone GitHub repository exists at `sergeville/youtube-comments-analyzer`.
- [x] Canonical local checkout is `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`.
- [x] README installation procedure is published.
- [x] Optional Ollama and Gemma 4 setup is documented.
- [x] Local Neo4j import, context backfill, and verification are runnable.
- [x] Existing nested checkout was preserved and is not treated as the canonical source.

### Phase 2: Give YCA its own operating context — complete

- [x] Add standalone `AGENTS.md`.
- [x] Add `project-manifest.json`.
- [x] Document Archon as the active execution and evidence system when coordination is needed.
- [x] Document Linear as an optional milestone mirror, not an execution authority.
- [x] Link the operating context from the README.

### Phase 3: Register coordination metadata — pending external operator action

- [ ] Create or select the YCA project in Archon.
- [ ] Record the Archon project/task identifier in `project-manifest.json`.
- [ ] Optionally create a Linear project mirror if milestone reporting is useful.
- [ ] Keep Linear status subordinate to Archon execution evidence.

No Archon or Linear connector is available in this session, so these registration steps
must be performed through the respective UIs or APIs by an authenticated operator.

### Phase 4: Retire duplicated ownership — pending deliberate cleanup

- [ ] Stop using `/Users/sergevilleneuve/Dev/Synapse/youtube-comments-analyzer` for new work.
- [ ] Archive or remove the nested checkout only after confirming no uncommitted work remains.
- [ ] Update any Synapse references to point to the canonical standalone checkout.

Do not delete the nested checkout automatically. It may contain local artifacts or
unpublished notes that need review first.

## Validation evidence

The latest standalone validation included:

- `npm run check` passed.
- `npm test` passed: 49 tests.
- Dashboard health endpoint returned HTTP 200.
- Neo4j context backfill and verification completed with zero context integrity errors.
