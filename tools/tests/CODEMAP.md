# tools/tests/

## Responsibility
Test harness and regression test suite for the `tools/` CLI toolchain, workflow engine, packaging and release automation, multi-harness portability, review and evidence integrity, prompt caching, and JEV subsystem. Provides deterministic unit tests, subprocess-isolated CLI acceptance tests, and empirical evaluation validation. Reusable helper modules (`test-helpers.mjs`, `npm-registry.mjs`, `jev-test-helpers.mjs`, `jev-native-test-helpers.mjs`) and static test datasets in `fixtures/` establish reproducible sandboxes without mutating user home or active repositories.

## Design Patterns
- **CLI Subprocess Acceptance & Sandboxing**: Out-of-process execution via `spawnSync(process.execPath, ...)` exercising commands under real CLI conditions with temp-dir sandboxing (`mkdtempSync`) and disposable git repositories (`createGitRepo`).
- **Exported-Helper Unit Testing**: Direct library-level unit assertions against pure functions, parsers, validators, hash calculators, and tariff models without subprocess overhead.
- **Golden-Fixture & Cassette Comparison**: Pre-recorded golden fixtures (`fixtures/cache/`, `fixtures/jev/`, `fixtures/return-contract/`) and cassette recordings (`recordCassette`, `replayCassette`) verifying deterministic output payloads and regression baselines.
- **Test Double & In-Memory Service Mock**: In-memory registry servers (`npm-registry.mjs`), mock HTTP endpoints, and synthetic host environments (`createMockPi`, `createMockCore`) simulating external services and agent extensions.
- **Shared Test Helpers (Not Test Cases)**:
  - `test-helpers.mjs`: Central repository and sandbox factories (`createTempDir`, `createGitRepo`, project stubs).
  - `npm-registry.mjs`: Lightweight mock HTTP npm registry server providing tarball distribution and metadata routes for installation and update tests.
  - `jev-test-helpers.mjs`: Evaluation, catalog, and policy mocking utilities for JEV suites.
  - `jev-native-test-helpers.mjs`: Native session trace, message mock, and extension runtime doubles for JEV native validation.

### Test Suites by Subject
- **Packaging & Release**:
  - `npm-distribution.test.mjs`: End-to-end npm distribution smoke test (`tools/npm-smoke.mjs`).
  - `package-certification.test.mjs`: Tarball structure, required manifest files, and archive validation (`tools/certify-package.mjs`, `tools/package-archive.mjs`).
  - `publish-preflight.test.mjs`: Preflight checks, release matrices, and publish gates (`tools/publish-release.mjs`).
  - `self-update.test.mjs`: Semver resolution, registry querying, and self-update CLI execution (`tools/self-update.mjs`).
  - `nullform-cli.test.mjs`: Main CLI interactive menus, state management, and argument dispatch (`bin/nullform.mjs`).
- **Harness Portability & Installation**:
  - `install-harness.test.mjs`: Full harness deployment engine and config patching (`tools/install-harness.mjs`).
  - `install-skills-assets.test.mjs`: Skill script, binary asset preservation, and ownership migrations (`tools/install-harness.mjs`).
  - `install-guard.test.mjs`: Harness installation safeguards and pre-condition checks (`tools/install-guard.mjs`).
  - `paseo-install.test.mjs`: Paseo-specific harness deployment and configuration (`tools/install-harness.mjs`).
  - `portable-runtime.test.mjs`: Fault tolerance, abandoned deployment journal recovery, locks, and cross-harness compatibility (`tools/installation/journal.mjs`, `tools/installation/state.mjs`).
  - `fix-plugin-windows.test.mjs`: Windows-specific plugin symlink and junction corrections (`tools/fix-plugin-windows.mjs`).
  - `symlink-entry.test.mjs`: Symlink traversal and junction entry point resolution (`tools/symlink-entry.mjs`).
- **Evidence, Review & Verification**:
  - `quality-evidence.test.mjs`: Quality evidence summary validation, observation hashes, and model calibration (`tools/quality-evidence.mjs`).
  - `review-evidence.test.mjs`: Review recording, Stage B validation, file hashing, and evidence envelopes (`tools/review/evidence.mjs`).
  - `review-integrity.test.mjs`: Dirty-status binding, EOL-agnostic hashing, and native tool execution integrity (`tools/review/evidence.mjs`, `tools/review/native-tools.mjs`).
  - `auto-review.test.mjs`: Native build/type/lint/test gating, missing-required evidence, non-npm argv checks and pre-dispatch/configuration boundaries (`tools/auto-review.mjs`).
  - `oracle-model.test.mjs`: Oracle prompt validation, acceptance verdict parsing, and model wrappers (`tools/oracle-model.mjs`).
  - `return-contract.test.mjs`: Structured completion contract and return header schema verification (`tools/return-contract.mjs`).
- **Benchmark, Evaluation & Replay**:
  - `benchmark.test.mjs`: Core workflow benchmarking execution, metric collection, and report generation (`tools/benchmark.mjs`).
  - `product-quality-consumer.test.mjs`: Real consumer controls, refund/invalid-input outcomes, exact workload totals and refusal of missing or broken checkers (`bench/fixtures/control-product-quality.mjs`, `bench/checks/check-product-quality.mjs`); no model dispatch or quality-uplift claim.
  - `bench-session-runner.test.ts`: Offline session runner execution and native tool spend reservation loop (`tools/bench-session-runner.ts`, `tools/bench-budget.mjs`).
  - `lm-replay.test.mjs`: LLM cassette recording, secret redaction, prompt normalization, and replay execution (`tools/lm-replay.mjs`).
  - `replay.test.mjs`: Session replay orchestration and step execution (`tools/replay.mjs`).
  - `skill-benefit-eval.test.mjs`: Tariff cost computation, request budgeting, native message validation, and benefit scoring (`tools/run-skill-benefit-eval.mjs`, `tools/bench-budget.mjs`).
  - `test_session_cost.py`: Python CLI session token and cost aggregation verification (`tools/session_cost.py`).
- **Sync & Workspace Lifecycle**:
  - `sync.test.mjs`: Bidirectional workspace synchronization engine and manifest diffing (`tools/sync.mjs`).
  - `sync-backup.test.mjs`: Pre-sync content diff backup creation and rollback safety (`tools/sync.mjs`).
  - `sync-prune.test.mjs`: Pruning orphaned and obsolete managed files (`tools/sync-prune.mjs`).
- **Workflow Gates, Audits & Metrics**:
  - `workflow-gate.test.mjs`: State machine lifecycle gates, step transitions, and artifact constraints (`tools/workflow.mjs`).
  - `workflow-audit.test.mjs`: Workflow verification gates, receipt identity across EOL mutations, and CI checks (`tools/workflow.mjs`, `tools/install-harness.mjs`).
  - `workflow-budget.test.mjs`: Workflow token and call budget warning thresholds and budget gate enforcement (`tools/workflow.mjs`).
  - `workflow-staleness.test.mjs`: Change staleness detection and branch tracking (`tools/workflow.mjs`).
  - `workflow-metrics.test.mjs`: Workflow execution metric calculation and reporting (`tools/workflow-metrics.mjs`).
  - `workflow-suggest.test.mjs`: Next-step workflow action recommendations (`tools/workflow-suggest.mjs`).
  - `bash-gates.test.mjs`: Destructive bash command interception and safety gates (`tools/bash-gates.mjs`).
  - `delete-guard.test.mjs`: Recursive deletion prevention rules, command matching, and interactive confirmations (`agent/extensions/nullform-delete-guard.ts`).
  - `session-retro.test.mjs`: Session transcript parsing, error scoring, retry ranking, and retro review cadence (`tools/session-retro.mjs`).
  - `skill-audit.test.mjs`: Skill prompt structural validation, reference resolution, and frontmatter checks (`tools/skill-audit.mjs`, `tools/prompt-lint.mjs`).
  - `prompt-cache.test.mjs`: Prompt caching analysis, token savings, and fingerprint tracking (`tools/prompt-cache.mjs`).
  - `cache-doctor.test.mjs`: Cache health diagnostics and invalidation checks (`tools/cache-doctor.mjs`).
  - `doctor.test.mjs`: Environment, dependency, and platform diagnostic suite (`tools/doctor.mjs`).
  - `skills-doctor.test.mjs`: Installed skills health and configuration diagnostics (`tools/doctor.mjs`).
  - `usage-audit.test.mjs`: LLM token and API usage log auditing (`tools/usage-audit.mjs`).
  - `debt-ledger.test.mjs`: Technical debt ledger parser, ceiling checks, and trigger validation (`tools/debt-ledger.mjs`).
  - `code-size.test.mjs`: File size budget limits and baseline drift checks (`tools/code-size.mjs`).
  - `context-inbox.test.mjs`: Context inbox message ingestion, filtering, and prioritization (`tools/context-inbox.mjs`).
  - `domain-context.test.mjs`: Domain model context extractor and dictionary consistency (`tools/domain-context.mjs`).
  - `memory-cadence.test.mjs`: Memory retention cadence, decay rules, and periodic synchronization (`tools/memory-cadence.mjs`).
  - `mutation-test.test.mjs`: Mutation testing harness and mutant survival checks (`tools/mutation-test.mjs`).
  - `gherkin-spec.test.mjs`: Gherkin feature specification validation and parser (`tools/gherkin-spec.mjs`).
  - `dashboard.test.mjs`: Status dashboard data aggregation and rendering (`tools/dashboard.mjs`).
  - `dashboard-autoreview.test.mjs`: Auto-review status wording regression (`unverified` is not a failure) (`tools/dashboard.mjs`).
  - `test-lens.test.mjs`: Test output filtering, noise reduction, and structured parsing (`tools/test-lens.mjs`).
- **JEV Subsystem & Extensions**:
  - `jev-evaluate.test.mjs`: Empirical evaluation and statistical comparison engine (`tools/jev-evaluate.mjs`).
  - `jev-control.test.mjs`: JEV control experiments and baseline assertions (`tools/jev-control.mjs`).
  - `jev-policy.test.mjs`: Decision policy threshold evaluation and validation (`tools/jev-policy.mjs`).
  - `jev-catalog.test.mjs`: Benchmark task catalog schema and task loader (`tools/jev-catalog.mjs`).
  - `jev-evidence.test.mjs`: Empirical evidence gathering and verification records (`tools/jev-evidence.mjs`).
  - `jev-assist.test.mjs`: LLM evaluation assistance and rubric scoring (`tools/jev-assist.mjs`).
  - `jev-extension.test.mjs`: JEV agent extension lifecycle and hook handling (`agent/extensions/nullform-jev.ts`).
  - `jev-extension-guards.test.mjs`: Extension tool-call security guards and parameter filters (`agent/extensions/nullform-jev.ts`).

## Data & Control Flow
1. Test runners (`node:test`, `bun test`, Python 3 `unittest`) discover and execute test files.
2. Sandboxes are provisioned via `mkdtempSync` in OS temporary directories; scratch git repos or harness configs are initialized using helper factories (`createGitRepo`, `createTempDir`).
3. CLI commands are executed out-of-process via `spawnSync(process.execPath, ...)` or invoked directly in-process for pure-logic modules.
4. Test execution exercises file transformations, mock HTTP endpoints (`npm-registry.mjs`), or synthetic agent host events.
5. Strict assertions (`node:assert/strict`) validate exit codes, stdout/stderr streams, JSON schemas, cryptographic digests, and resulting filesystem state.
6. Temporary sandboxes and mock servers are cleanly released in `finally` blocks or process exit handlers.

## Integration Points
- **Target Tools & Binaries**: Direct CLI execution and imports for `tools/*.mjs`, `tools/*.ts`, `bin/nullform.mjs`, `tools/session_cost.py`, and agent extensions in `agent/extensions/nullform-*.ts`.
- **Fixtures Directory (`tools/tests/fixtures/`)**: Static datasets and review runners including `fixtures/cache/` (JSONL transcripts), `fixtures/jev/` (`calibration.json`, `heldout.json`), `fixtures/return-contract/` (`valid.md`), and `fixtures/review-execution.mjs`.
- **Shared Test Helpers**: Common utilities in `tools/tests/test-helpers.mjs`, `tools/tests/npm-registry.mjs`, `tools/tests/jev-test-helpers.mjs`, and `tools/tests/jev-native-test-helpers.mjs`.
- **CI & Verification Gateways**: Invoked by top-level verification scripts `verify.ps1`, `verify.sh`, `tools/verify.mjs` (`node --test`), and workflow CI audit gates (`cmdCheckCi`).
