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

### Phase 3: Register coordination metadata — Archon complete; Linear optional

- [x] Create or select the YCA project in Archon: `YouTube Comments Analyzer` (`7cf8e16e-ae71-4f65-9687-fe99c4afa935`).
- [x] Record the Archon project/task identifier in `project-manifest.json`: task `YCA standalone coordination anchor` (`5fa72720-275d-47b0-a42c-5314f23852b8`).
- [ ] Optionally create a Linear project mirror if milestone reporting is useful. Deferred; no Linear mirror is needed for current execution evidence.
- [ ] Keep Linear status subordinate to Archon execution evidence.

Archon registration was completed through the local Archon API on 2026-07-15. The
backend is the confirmed registration path; MCP configuration exists in Codex, but the
MCP endpoint must be rechecked after the Archon service is restarted. No Linear
connector is available in this session, and Linear remains an optional milestone mirror
only.

### Phase 4: Retire duplicated ownership — pending deliberate cleanup

- [x] Stop using `/Users/sergevilleneuve/Dev/Synapse/youtube-comments-analyzer` for new work; canonical guardrails are recorded in `AGENTS.md`, `project-manifest.json`, and `docs/YCA_phase4_retirement_audit.md`.
- [ ] Archive or remove the nested checkout only in a separate approved Synapse cleanup change. The nested YCA-local dirty artifacts were preserved and cleaned on 2026-07-15.
- [ ] Update active Synapse references to point to the canonical standalone checkout. Historical completed BMAD story references are preserved as audit history.

Do not delete the nested checkout automatically. It may contain local artifacts or
unpublished notes that need review first.

## Validation evidence

The latest standalone validation included:

- `npm run check` passed.
- `npm test` passed: 49 tests.
- Dashboard health endpoint returned HTTP 200.
- Neo4j context backfill and verification completed with zero context integrity errors.
- Archon backend health returned healthy on `http://127.0.0.1:8181/health`.
- Archon MCP task evidence: the `archon-mcp` container is running; in-container `/health` returned healthy and `/sse` returned HTTP 200 with `text/event-stream`. Host `localhost:8051` remains unreachable from this shell, so Codex client-level MCP availability still needs confirmation after session reload.
- Archon project registered: `YouTube Comments Analyzer` (`7cf8e16e-ae71-4f65-9687-fe99c4afa935`).
- Archon coordination task registered: `YCA standalone coordination anchor` (`5fa72720-275d-47b0-a42c-5314f23852b8`).
- Archon follow-up task created for MCP recovery: `fb881eeb-97ac-4d38-925c-5beee7608aee`.
- Archon follow-up task created for active Synapse reference audit: `0fa968e2-ddf7-48af-a38f-82b699d94eb4`.
- Archon follow-up task created for nested checkout retirement approval: `8def6bde-fb0f-4562-8bc6-15b2af46d3ea`.
- Linear milestone mirror created: `YouTube Comments Analyzer` (`ed8e217d-e938-4363-a958-d19de752c66c`) in team `MoveToLinear`.
- Linear project: https://linear.app/movetolinear/project/youtube-comments-analyzer-f3c339c79844
- Phase 4 retirement audit added at `docs/YCA_phase4_retirement_audit.md`; dirty nested artifacts were preserved in `docs/archive/` and ignored local output archive `output/.retirement-audit/2026-07-15/`.
