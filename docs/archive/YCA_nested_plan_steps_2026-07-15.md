# YCA Plan Steps

Status: In progress
Updated: 2026-07-15
Plan: [`YCA_STANDALONE_PROJECT_PLAN.md`](./YCA_STANDALONE_PROJECT_PLAN.md)

## 1. Tracking Decision

Archon is the recommended active system for this migration. It should own the executable task, current agent task, approval boundary, validation evidence, and completion state.

Linear can be used as an optional high-level mirror for milestones, dates, and reminders. Linear must not become a second execution system or a second source of technical truth.

Boundary:

- Archon: execution, task state, evidence, approvals, runtime context, and audit trail.
- Linear: optional milestone visibility and planning summary.
- GitHub: source code, reviews, commits, branches, and releases.
- YCA README/docs: user-facing setup and operating instructions.

No paid API use, agent execution, or destructive migration action starts automatically from this file.

## 2. Step Status

### Phase 1: Standalone Source Of Truth

- [x] Standalone GitHub repository created at `sergeville/youtube-comments-analyzer`.
- [x] Project files published at repository root.
- [x] README installation procedure published.
- [x] Gemma 4 Ollama setup documented.
- [x] Standalone checkout tested with syntax checks and 49 unit tests.
- [x] Create canonical local checkout at `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`.
- [x] Transfer only approved local state (`.env` values; generated output remains local to each checkout).
- [x] Run final standalone live validation from the new canonical path: syntax check, 49 tests, HTTP 200 dashboard, Neo4j dry run, context backfill, and verifier all passed.
- [ ] Register the new canonical path as the only YCA development location.

Current phase status: **Standalone checkout complete; Synapse registration remains.**

### Phase 2: Project-Local Operating Context

- [ ] Add standalone YCA `AGENTS.md`.
- [ ] Add a YCA project manifest with repository, path, commands, port, health URL, and optional services.
- [ ] Document the Synapse capabilities YCA consumes without copying Synapse source.
- [ ] Create the Archon task/story for the migration and set `workflow:codex.current_task` only when implementation begins.

### Phase 3: Synapse Project Bootstrap

- [ ] Define the project bootstrap input and dry-run contract.
- [ ] Implement creation outside the Synapse repository.
- [ ] Generate project-local instructions, manifest, environment template, and initial BMAD context.
- [ ] Register the project path and lifecycle commands with Synapse.
- [ ] Add overwrite protection for non-empty target directories.

### Phase 4: Runtime Integration

- [ ] Register YCA as a standalone local component.
- [ ] Add health monitoring for `http://127.0.0.1:4478/health`.
- [ ] Add start/stop/inspect routing without Synapse owning YCA files.
- [ ] Record launch and validation evidence in Archon.
- [ ] Keep integration fail-open and local-first.

### Phase 5: Nested Checkout Retirement

- [ ] Freeze changes in `Synapse/youtube-comments-analyzer`.
- [ ] Compare standalone and nested source/docs/configuration.
- [ ] Preserve a rollback archive or tag.
- [ ] Remove the nested project in a separate approved change.
- [ ] Update Synapse references and verify its worktree no longer tracks YCA source changes.

## 3. Immediate Next Action

Create the canonical external checkout and validate it before touching or deleting the nested checkout. This is the first action that changes the project topology, so it requires preserving the current nested state and keeping the migration reversible.

## 4. Completion Definition

This migration is complete when the external checkout is the only YCA source of truth, Synapse can register and supervise it through explicit contracts, Archon owns the active execution evidence, Linear is optional and non-authoritative, and the nested checkout has been archived or removed through a separate approved change.
