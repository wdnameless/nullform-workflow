# tools/tests/

## Responsibility
Test suite and regression verification harness for the `tools/` CLI toolchain, workflow engine, harness installation and portability layer, review and evidence integrity, prompt caching, CI change-scope gates, and JEV subsystem. Provides deterministic unit assertions and subprocess-isolated CLI acceptance tests across 122 `*.test.mjs` suites (plus one Bun/TS benchmark runner suite and `test_session_cost.py`). Guarantees zero ambient pollution of developer workspaces or user configuration via temporary directory sandboxing, disposable git repositories, and sanitized environment variables.

## Design Patterns
- **Runner Convention & Strict Assertions**: All 122 `*.test.mjs` suites adhere to Node's built-in `node:test` runner (`import test from "node:test"` or `import { test } from "node:test"`) paired with `node:assert/strict`. The sole TypeScript exception is `bench-session-runner.test.ts` (executed via Bun for TypeScript benchmark sessions), while `test_session_cost.py` is the only Python suite.
- **Shared Harness Sandboxing (`test-helpers.mjs`)**: Central test helper imported by 26 suites, providing `createTempDir(prefix)` (allocating isolated paths under `os.tmpdir()`) and `createGitRepo(prefix)` (spawning disposable git repositories with initial commit and safe test git identity). Role-specific variants live beside it: `jev-test-helpers.mjs` (imported by 3 suites) and `jev-native-test-helpers.mjs` (imported by 2 suites); `npm-registry.mjs` supplies mock package registry fixtures.
- **Filesystem & Subprocess Isolation**: CLI commands execute out-of-process via `spawnSync(process.execPath, ...)` or `bash` under dedicated scratch cwd. Installer tests strip ambient variables (`HOME`, `USERPROFILE`, `LOCALAPPDATA`, `NULLFORM_USER_HOME`, `HERMES_*`) to prevent reading or mutating real user journals (`~/.nullform`) or active repositories.
- **Fixture Runner & Static Dataset Seeding (`fixtures/`)**: Static datasets and shared runners reside in `tools/tests/fixtures/`. `review-execution.mjs` (imported by 8 suites) exports `writeEvidence` and `prepareEvidence` for synthesizing review bundles; subdirectories supply deterministic baselines: `fixtures/cache/` (JSONL transcripts and token fingerprints), `fixtures/jev/` (`calibration.json`, `heldout.json`), and `fixtures/return-contract/` (`valid.md`).
- **Family-Based Organization**: The 122 `*.test.mjs` test suites are structured into cohesive families alongside single-module suites:
  - `jev` (8): `jev-evaluate`, `jev-control`, `jev-policy`, `jev-catalog`, `jev-evidence`, `jev-assist`, `jev-extension`, `jev-extension-guards`.
  - `workflow` (8): `workflow-gate`, `workflow-audit`, `workflow-budget`, `workflow-staleness`, `workflow-metrics`, `workflow-suggest`, `workflow-workspaces`, `workflow-beats`.
  - `review` (8): `review-evidence`, `review-integrity`, `review-arbitration`, `review-budget`, `review-controlled-http`, `review-boundaries`, `reviewer-modes`, `cross-model`.
  - `bench` & `benchmark` (4): `benchmark`, `benchmark-integration`, `bench-optimizer`, `bench-budget-matrix` (plus `p-bench` and Bun TS runner `bench-session-runner.test.ts`).
  - `ci-gate` & `verification` (11): `changed-scope`, `clone-coverage`, `coverage-changed`, `mutation-test`, `cfr-report`, `lead-time`, `model-router`, `gate-counter`, `perf-gate`, `verify-matrix`, `manifest-verify` (alongside `sync-manifest-coverage`). All direct-import their tested modules; `coverage-changed` and `harness-probe` additionally import `../../bin/nullform.mjs` to exercise the CLI↔gate interface.
  - `dashboard` (5): `dashboard`, `dashboard-lifecycle`, `dashboard-sketch`, `dashboard-autoreview`, `dashboard-run`.
  - `doctor` (5): `doctor`, `dependency-doctor`, `skills-doctor`, `cache-doctor`, `worktree-doctor`.
  - `install` & `setup` (5): `install-harness`, `install-skills-assets`, `install-guard`, `install-smoke-r02`, `paseo-install`.
  - `ap` (4): `ap-discipline`, `ap-ops`, `ap-run`, `ap-gates` (governance, execution, and protocol gates).
  - `u-*` (4): `u-waves`, `u-quality`, `u-brief`, `u-install` (micro-agent workflows and wave operations).
  - `routing` & `replay` (4): `routing-resilience`, `replay`, `lm-replay`, `oracle-model`.
  - `skill` (3): `skill-audit`, `skill-benefit-eval`, `skill-security`.
  - `sync` (3): `sync`, `sync-backup`, `sync-prune`.
  - `cost` & `spend` (2): `lane-cost`, `spend-safety` (plus `test_session_cost.py`).
  - `round2` (2): `round2-routing`, `round2-safety` (routing and edit safety).
  - `quality` (2): `quality`, `quality-evidence`.
  - `task` (2): `task-claim`, `task-claim-cli`.
  - `worktree` (2): `worktree-doctor`, `worktree-snapshot`.
  - `lifecycle` & `contract` (2): `lifecycle-evals`, `return-contract`.
  - `p-*` (2): `p-bench`, `p-publish` (packaging and publish preflight).
  - Single-module tests (~35): targeted unit coverage for individual utilities including `init-wizard`, `apple-shell`, `domain-context`, `publish-preflight`, `prompt-cache`, `self-update`, `nullform-cli`, `auto-review`, `debt-ledger`, `code-size`, `harness-probe`, `test-lens`, `adaptive-harness-cli`, `bash-gates`, `carry-lock`, `context-inbox`, `contrast-check`, `delete-guard`, `deployment-journal`, `fix-plugin-windows`, `gherkin-spec`, `harness-profiles`, `memory-cadence`, `native-setup-precedence`, `npm-distribution`, `oss-safety`, `package-certification`, `portable-runtime`, `product-quality-consumer`, `round2-ops`, `sanitize-text`, `session-retro`, `setup-heal`, `symlink-entry`, `usage-audit`, and `verify-status`.

## Data & Control Flow
1. **Runner Discovery**: Test runner executes suites via `node --test tools/tests/*.test.mjs` (`bench-session-runner.test.ts` via Bun, `test_session_cost.py` via Python). Top-level scripts (`verify.ps1`, `verify.sh`, `tools/verify.mjs`) route test execution through `test-lens.mjs` for structured output filtering.
2. **Sandbox Provisioning**: Tests allocate isolated working directories via `createTempDir()` or `mkdtempSync`; git-dependent tests call `createGitRepo()` to create pristine scratch repositories.
3. **Execution**:
   - *In-Process Unit Tests*: Direct imports and functional execution of pure-logic modules (`workflow.mjs`, `review/evidence.mjs`, `installation/config.mjs`, `dashboard.mjs`, `doctor.mjs`).
   - *Subprocess Acceptance*: Out-of-process invocation via `spawnSync(process.execPath, [script, ...args], { cwd, env })` with isolated environment variables.
4. **Fixture Ingestion**: Tests load static datasets from `fixtures/cache/` or `fixtures/jev/`, or invoke `./fixtures/review-execution.mjs` to stage mock evidence trees.
5. **Assertion & Teardown**: Strict validation using `node:assert/strict` (`equal`, `deepEqual`, `match`, `throws`); scratch directories and test fixtures are unlinked in `finally` blocks or abandoned to OS temp cleanup.

## Integration Points
- **Core Tested Modules (Highest Test Density)**:
  - `tools/workflow.mjs`: Workflow transitions, artifact contracts, and phase gates (`cmdStart`, `cmdArtifact`, `cmdCheck`, `cmdEscalate`, `cmdClose`, `cmdCheckCi`).
  - `tools/review/evidence.mjs`: Review evidence creation, integrity checks, and Stage B verification envelopes.
  - `tools/install-harness.mjs` & `tools/installation/` modules (`config.mjs`, `state.mjs`, `profiles.mjs`): Multi-harness deployment, config patching, and migration state.
  - `tools/dashboard.mjs`: Aggregated dashboard data presentation and autoreview verification status.
  - `tools/jev-assist.mjs`: Rubric scoring and LLM evaluation parsing.
  - `tools/doctor.mjs` & `tools/cost-snapshot.mjs`: Platform diagnostics, dependency verification, and token cost snapshots.
- **Support & Fixture Infrastructure**:
  - `tools/tests/test-helpers.mjs`: Central sandbox factories (`createTempDir`, `createGitRepo`) imported across 26 suites.
  - `tools/tests/fixtures/review-execution.mjs`: Shared evidence generator (`writeEvidence`, `prepareEvidence`) imported by 8 suites.
  - `tools/tests/jev-test-helpers.mjs` & `tools/tests/jev-native-test-helpers.mjs`: JEV-specific sandbox and Bun runner helpers (imported by 3 and 2 suites respectively).
  - `tools/tests/npm-registry.mjs`: Mock registry server utilities for package installation and publication preflight tests.
  - `tools/tests/fixtures/`: Static datasets (`cache/`, `jev/`, `return-contract/`).
- **Binaries & Extensions**: Direct CLI execution for `bin/nullform.mjs`, `install.sh`, and extension hooks in `agent/extensions/nullform-delete-guard.ts` and `agent/extensions/nullform-jev.ts`.
- **Verification Pipeline**: Integrated into `tools/verify.mjs`, `tools/test-lens.mjs`, `verify.ps1`, `verify.sh`, and CI gate checks (`cmdCheckCi`).
