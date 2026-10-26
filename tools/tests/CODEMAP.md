# tools/tests/

## Responsibility
Test suite and regression verification harness for the `tools/` CLI toolchain, workflow engine, harness installation and portability layer, review and evidence integrity, prompt caching, and JEV subsystem. Provides deterministic unit assertions and subprocess-isolated CLI acceptance tests across 100 `*.test.mjs` suites (plus one Bun/TS benchmark runner suite). Guarantees zero ambient pollution of developer workspaces or user configuration via temporary directory sandboxing, disposable git repositories, and sanitized environment variables.

## Design Patterns
- **Runner Convention & Strict Assertions**: 99 of 100 suites adhere to Node's built-in `node:test` runner (`import test from "node:test"`) paired with `node:assert/strict`. The sole exception is `bench-session-runner.test.ts` (executed via Bun for TypeScript benchmark sessions).
- **Shared Harness Sandboxing (`test-helpers.mjs`)**: Central test helper imported by 16 suites, providing `createTempDir(prefix)` (allocating isolated paths under `os.tmpdir()`) and `createGitRepo(prefix)` (spawning disposable git repositories with initial commit and safe test git identity).
- **Filesystem & Subprocess Isolation**: CLI commands execute out-of-process via `spawnSync(process.execPath, ...)` or `bash` under dedicated scratch cwd. Installer tests strip ambient variables (`HOME`, `USERPROFILE`, `LOCALAPPDATA`, `NULLFORM_USER_HOME`, `HERMES_*`) to prevent reading or mutating real user journals (`~/.nullform`) or active repositories.
- **Fixture Runner & Static Dataset Seeding (`fixtures/`)**: Static datasets and shared runners reside in `tools/tests/fixtures/`. `review-execution.mjs` (imported by 7 suites) exports `writeEvidence` and `prepareEvidence` for synthesizing review bundles; subdirectories supply deterministic baselines: `fixtures/cache/` (JSONL transcripts and token fingerprints), `fixtures/jev/` (`calibration.json`, `heldout.json`), and `fixtures/return-contract/` (`valid.md`).
- **Family-Based Organization**: The 100 test suites are structured into 14 multi-test families alongside ~47 single-module suites:
  - `jev` (8): `jev-evaluate`, `jev-control`, `jev-policy`, `jev-catalog`, `jev-evidence`, `jev-assist`, `jev-extension`, `jev-extension-guards`.
  - `workflow` (7): `workflow-gate`, `workflow-audit`, `workflow-budget`, `workflow-staleness`, `workflow-metrics`, `workflow-suggest`, `workflow-workspaces`.
  - `review` (6): `review-evidence`, `review-integrity`, `review-arbitration`, `review-budget`, `review-controlled-http`, `review-boundaries`.
  - `ap` (4): `ap-discipline`, `ap-ops`, `ap-run`, `ap-gates` (governance, execution, and protocol gates).
  - `dashboard` (4): `dashboard`, `dashboard-lifecycle`, `dashboard-sketch`, `dashboard-autoreview`.
  - `round2` (4): `round2-routing`, `round2-ops`, `round2-evidence`, `round2-safety`.
  - `u-*` (4): `u-waves`, `u-quality`, `u-brief`, `u-install` (micro-agent workflows and wave operations).
  - `install` (3): `install-harness`, `install-skills-assets`, `install-guard`.
  - `sync` (3): `sync`, `sync-backup`, `sync-prune`.
  - `p-*` (2): `p-bench`, `p-publish` (packaging and publish preflight).
  - `quality` (2): `quality`, `quality-evidence`.
  - `skill` (2): `skill-audit`, `skill-benefit-eval`.
  - `task` (2): `task-claim`, `task-claim-cli`.
  - `worktree` (2): `worktree-doctor`, `worktree-snapshot`.
  - Single-module tests (~47): targeted unit coverage for individual utilities including `doctor`, `prompt-cache`, `self-update`, `nullform-cli`, `auto-review`, `debt-ledger`, `code-size`, and `test-lens`.

## Data & Control Flow
1. **Runner Discovery**: Test runner executes suites via `node --test tools/tests/*.test.mjs` (`bench-session-runner.test.ts` via Bun). Top-level scripts (`verify.ps1`, `verify.sh`, `tools/verify.mjs`) route test execution through `test-lens.mjs` for structured output filtering.
2. **Sandbox Provisioning**: Tests allocate isolated working directories via `createTempDir()` or `mkdtempSync`; git-dependent tests call `createGitRepo()` to create pristine scratch repositories.
3. **Execution**:
   - *In-Process Unit Tests*: Direct imports and functional execution of pure-logic modules (`workflow.mjs`, `review/evidence.mjs`, `installation/config.mjs`, `dashboard.mjs`, `doctor.mjs`).
   - *Subprocess Acceptance*: Out-of-process invocation via `spawnSync(process.execPath, [script, ...args], { cwd, env })` with isolated environment variables.
4. **Fixture Ingestion**: Tests load static datasets from `fixtures/cache/` or `fixtures/jev/`, or invoke `./fixtures/review-execution.mjs` to stage mock evidence trees.
5. **Assertion & Teardown**: Strict validation using `node:assert/strict` (`equal`, `deepEqual`, `match`, `throws`); scratch directories and test fixtures are unlinked in `finally` blocks or abandoned to OS temp cleanup.

## Integration Points
- **Core Tested Modules (Highest Test Density)**:
  - `tools/workflow.mjs` (14 tests): Workflow transitions, artifact contracts, and phase gates (`cmdStart`, `cmdArtifact`, `cmdCheck`, `cmdEscalate`, `cmdClose`, `cmdCheckCi`).
  - `tools/review/evidence.mjs` (7 tests): Review evidence creation, integrity checks, and Stage B verification envelopes.
  - `tools/install-harness.mjs` (6 tests) & `tools/installation/` modules (`config.mjs` [5], `state.mjs` [5], `profiles.mjs` [4]): Multi-harness deployment, config patching, and migration state.
  - `tools/dashboard.mjs` (5 tests): Aggregated dashboard data presentation and autoreview verification status.
  - `tools/jev-assist.mjs` (5 tests): Rubric scoring and LLM evaluation parsing.
  - `tools/doctor.mjs` (4 tests) & `tools/cost-snapshot.mjs` (4 tests): Platform diagnostics, dependency verification, and token cost snapshots.
- **Support & Fixture Infrastructure**:
  - `tools/tests/test-helpers.mjs`: Central sandbox factories (`createTempDir`, `createGitRepo`) imported across 16 suites.
  - `tools/tests/fixtures/review-execution.mjs`: Shared evidence generator (`writeEvidence`, `prepareEvidence`) imported by 7 suites.
  - `tools/tests/fixtures/`: Static datasets (`cache/`, `jev/`, `return-contract/`).
- **Binaries & Extensions**: Direct CLI execution for `bin/nullform.mjs`, `install.sh`, and extension hooks in `agent/extensions/nullform-delete-guard.ts` and `agent/extensions/nullform-jev.ts`.
- **Verification Pipeline**: Integrated into `tools/verify.mjs`, `tools/test-lens.mjs`, `verify.ps1`, `verify.sh`, and CI gate checks (`cmdCheckCi`).
