# YCA Standalone Project Plan

Status: Proposed
Owner: Synapse project bootstrap and operator workflow
Scope: YouTube Comments Analyzer (YCA)
Target repository: `https://github.com/sergeville/youtube-comments-analyzer`
Target local path: `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`

## 1. Objective

Make YCA a genuinely standalone project while preserving the useful capabilities that Synapse provided during its creation: project context, shared skills, BMAD discipline, Archon task visibility, launch commands, health checks, validation, and operator traceability.

YCA must have one authoritative repository, one authoritative local path, and one clear relationship to Synapse. Synapse should create, register, supervise, and assist YCA without owning YCA source files.

## 2. Current Problem

- YCA source currently exists under the Synapse repository at `Synapse/youtube-comments-analyzer`.
- YCA has also been published as a separate GitHub repository.
- The two copies have different Git histories, README content, generated output, and working states.
- Folder inheritance made Synapse instructions available, but it also blurred repository ownership.
- The local dashboard can therefore be started from the wrong checkout.

## 3. Target Architecture

```text
/Users/sergevilleneuve/Dev/Synapse/
  Synapse source, Archon, shared skills, governance, and project registry

/Users/sergevilleneuve/Dev/youtube-comments-analyzer/
  Independent YCA Git repository and runtime
```

Synapse remains the factory and operator layer. YCA remains the product repository. Shared behavior is delivered through explicit contracts, generated project context, Archon APIs, launcher commands, and reusable skills rather than parent-folder inheritance.

## 4. Non-Negotiable Invariants

- YCA source files are not tracked by the Synapse Git repository after migration.
- YCA has its own `.git`, remote, branch policy, README, tests, environment, and release history.
- YCA never imports Synapse product/task data into its YouTube comment graph.
- Secrets, generated output, and Neo4j volumes remain local and are never committed.
- Synapse integrations are additive and fail gracefully when Synapse or Archon is unavailable.
- A project can be created from Synapse without copying the whole Synapse repository.
- The old nested checkout is preserved until the new checkout passes validation and a human confirms retirement.

## 5. Implementation Phases

### Phase 1: Establish the Standalone Source of Truth

1. Confirm the standalone GitHub repository contains the complete YCA project at its root.
2. Clone it to `/Users/sergevilleneuve/Dev/youtube-comments-analyzer`.
3. Copy only intentionally retained local state: `.env` values entered by the operator and selected ignored sample output if needed.
4. Do not copy `.git`, Synapse metadata, unrelated generated files, or private credentials.
5. Run `npm run check`, `npm test`, Neo4j dry run, dashboard smoke test, and live Neo4j verification.
6. Record the new path as the only canonical YCA development path.

### Phase 2: Add Project-Local Operating Context

1. Add a YCA-specific `AGENTS.md` containing project scope, commands, safety rules, testing, ports, and Git workflow.
2. Keep shared Synapse rules as references or generated context, not as copied parent-repository ownership.
3. Add a small project manifest describing repository URL, local path, start command, test command, health URL, and optional dependencies.
4. Document which Synapse capabilities YCA consumes: shared skills, Archon task context, launcher integration, validation, and memory conventions.

### Phase 3: Build Synapse Project Bootstrap

Add a Synapse-owned project bootstrap workflow that:

1. Accepts a project name, repository URL or template, local path, and project profile.
2. Creates the project outside the Synapse repository.
3. Generates the project-local `AGENTS.md`, README setup section, manifest, and environment template.
4. Registers the project with Synapse without copying Synapse source into it.
5. Creates or links the BMAD story and Archon task before product-code work begins.
6. Supports a dry-run preview and refuses to overwrite an existing non-empty directory.

The first implementation should be a boring, explicit CLI or script. A UI can follow after the filesystem and registry contracts are proven.

### Phase 4: Add Explicit Runtime Integration

1. Register YCA as a standalone local component with its own command and port.
2. Add health checking for `http://127.0.0.1:4478/health`.
3. Allow Synapse to start, stop, and inspect YCA without owning its source files.
4. Keep Neo4j credentials and Ollama configuration in YCA's environment boundary.
5. Record launch, health, and validation results in Synapse/Archon traces where appropriate.
6. Make all integration read-only or fail-open unless an operator explicitly requests a mutation.

### Phase 5: Migrate and Retire the Nested Checkout

1. Freeze product changes in the nested `Synapse/youtube-comments-analyzer` directory.
2. Compare source, docs, tests, configuration, and generated-output policy between both copies.
3. Validate the standalone checkout with the complete acceptance checklist.
4. Preserve a dated archive or Git tag of the nested state for rollback.
5. Remove the nested project from the Synapse repository only in a separate approved change.
6. Update Synapse documentation and registries to reference the standalone path.
7. Verify Synapse status no longer reports YCA source changes as Synapse changes.

## 6. Acceptance Checklist

- `git -C /Users/sergevilleneuve/Dev/youtube-comments-analyzer status` is clean.
- The standalone remote is `https://github.com/sergeville/youtube-comments-analyzer.git`.
- `npm run check` passes.
- `npm test` passes.
- Dashboard starts from the standalone directory on the registered port.
- Dashboard, report, transcript, document, channel, and health routes respond successfully.
- Neo4j dry run performs no writes.
- Neo4j import and verification work with local credentials.
- Context relations remain exactly-once and aggregate counts remain consistent.
- Optional Ollama mind-map generation works with the configured model or reports a clear setup error.
- A new user can follow the standalone README from `git clone` to first successful dashboard load.
- Synapse can register and supervise YCA without tracking YCA source files.

## 7. Rollback

Rollback means stopping the standalone runtime and restoring the archived nested checkout or prior Git revision. Do not delete the nested checkout, Neo4j volume, or generated output until the standalone acceptance checklist is complete and the operator approves retirement.

## 8. Recommended Order

Complete Phases 1 and 2 first. Then implement the smallest bootstrap and project-registry slice in Phase 3. Add runtime supervision in Phase 4 only after the standalone path is stable. Retire the nested checkout last.

The immediate next story should be: **YCA standalone checkout and Synapse project registration**.
