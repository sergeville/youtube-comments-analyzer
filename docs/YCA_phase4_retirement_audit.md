# YCA Phase 4 Retirement Audit

Date: 2026-07-15

## Purpose

This audit records the current state of the historical nested YCA checkout before any retirement action. It exists to prevent accidental reuse or deletion of local artifacts while the standalone repository remains the source of truth.

## Canonical Source Of Truth

- Canonical checkout: `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`
- Repository: `https://github.com/sergeville/youtube-comments-analyzer.git`
- Archon project: `YouTube Comments Analyzer` (`7cf8e16e-ae71-4f65-9687-fe99c4afa935`)
- Archon task: `YCA standalone coordination anchor` (`5fa72720-275d-47b0-a42c-5314f23852b8`)

## Deprecated Nested Checkout

- Nested checkout: `/Users/sergevilleneuve/Dev/Synapse/youtube-comments-analyzer`
- Nested checkout branch at audit time: `dev`
- Nested checkout commit at audit time: `23732d334b8a0f23a37b5a6370df96a810e143f1`
- Parent Synapse repo had unrelated local changes at audit time.

At initial audit time the nested checkout was not safe to archive or remove automatically because it had local state:

- Modified generated output under `output/` for `WALe2iQvaOk` and `neUqTZiFKq4`. Preserved locally under `output/.retirement-audit/2026-07-15/` in the canonical checkout.
- Untracked nested migration notes: `docs/YCA_STANDALONE_PROJECT_PLAN.md` and `docs/YCA_plan_steps.md`. Preserved as archived docs under `docs/archive/` in the canonical checkout.
- The parent Synapse worktree also reported unrelated local changes outside the analyzer folder.

## Reference Inventory

Synapse still contains historical YCA references in BMAD artifacts, including:

- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `_bmad-output/implementation-artifacts/stories/yca-1-neo4j-hardening.md`
- `_bmad-output/implementation-artifacts/stories/yca-6-import-idempotency-and-graph-viz.md`
- `_bmad-output/implementation-artifacts/stories/yca-7-promote-local-dashboard-and-channel-pipeline.md`
- `_bmad-output/implementation-artifacts/stories/yca-8-unified-page-navigation.md`

Those files are historical governance evidence. Do not rewrite completed story history just to remove old relative paths. Future active work should reference the canonical checkout explicitly.

## Decision

- New YCA work must use `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`.
- `/Users/sergevilleneuve/Dev/Synapse/youtube-comments-analyzer` is preserved for comparison and artifact recovery only.
- The nested checkout's YCA-local dirty artifacts were reviewed, preserved, and cleaned on 2026-07-15. Removing the nested checkout from Synapse remains a separate approved Synapse cleanup change.
- Linear remains optional and non-authoritative.

## Recommended Next Cleanup

1. Decide whether the ignored generated-output archive under `output/.retirement-audit/2026-07-15/` should remain local-only or be deleted later. Do not commit it by default.
2. Archive or remove the nested checkout from Synapse in a separate approved cleanup change, after checking Synapse governance requirements for tracked source removal.
3. Add a current Synapse-side note pointing future YCA work to `/Users/sergevilleneuve/Dev/youtube-comments-analyzer` if new Synapse planning docs are created.
4. Preserve completed BMAD story history as-is unless a future governance story explicitly asks for a current-reference correction.


## Preservation Completed

On 2026-07-15, Codex preserved the nested checkout's useful local artifacts before cleaning the nested YCA-local working state:

- Archived nested migration docs in `docs/archive/YCA_STANDALONE_PROJECT_PLAN_2026-07-15.md` and `docs/archive/YCA_nested_plan_steps_2026-07-15.md`.
- Copied the six dirty generated-output files into the ignored local archive `output/.retirement-audit/2026-07-15/`.
- Restored the nested tracked generated-output files and removed the two copied untracked nested docs.

After this preservation step, `git -C /Users/sergevilleneuve/Dev/Synapse/youtube-comments-analyzer status --short` no longer reported YCA-local changes. The parent Synapse worktree still had unrelated changes outside the analyzer folder.
