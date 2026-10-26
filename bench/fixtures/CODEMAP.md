# bench/fixtures/

## Responsibility
Scenario construction, fixture factories, deterministic behavioral controls, and regression test data for the benchmark harness. Materializes starting Git repository states (synthetic requirements manifests, seeded source trees, two-stage commit histories, and frozen tests) inside isolated runner workspaces for model evaluation, provides hand-written positive and negative behavioral control implementations that prove downstream checkers discriminate defects without model dispatch, and supplies canned run-score fixtures for harness smoke testing.

## Design Patterns
- **Fixture Factory / Scenario Builder (`setup-*.mjs`)**: Standalone CLI scripts executed in target `process.cwd()` that write `manifest.md` declarations and commit deterministic Git revisions:
  - `setup-review-positive.mjs` (`eval-review-positive`): Seeds two-stage Git history (`HEAD~1` baseline with start/stop pipeline events in `src/events.ts`, `src/dispatcher.ts`, `src/utils.ts`; `HEAD` commit adding unhandled `pause` event to `src/events.ts` and redundant `customPad` helper to `src/utils.ts` without dispatcher handling).
  - `setup-near-negative.mjs` (`eval-review-near-negative`): Seeds clean single-commit Git repository (`HEAD` with working `src/cli.mjs` printing hello and exiting 0) and tabular `manifest.md` (R01–R02 marked done).
  - `setup-defect-outcome.mjs` (`eval-review-defect-outcome`): Seeds two-stage Git history (`HEAD~1` with `ExportCsv`/`ExportJson` in `src/commands.ts`, `src/router.ts`, `src/utils.ts`; `HEAD` commit adding unhandled `ExportReport` command in `src/commands.ts` and JSON-serializing `shallowOrDeepCopy` in `src/utils.ts`).
  - `setup-workflow-outcome.mjs` (`eval-workflow-execution-outcome`): Seeds repository with stubbed `src/calc.mjs` (working `add`, throwing `multiply`), immutable test suite `tests/calc.test.mjs`, and `manifest.md` (R01–R03).
  - `setup-product-quality.mjs` (`eval-product-quality-consumer`): Seeds bounded maintenance consumer with verified Git root boundaries, `manifest.md` (R01–R05), and initial working baseline `src/order-summary.mjs` (summarizes positive orders; refunds unimplemented). Commits strictly these two files.
- **Deterministic Behavioral Control Runner (`control-product-quality.mjs`)**: CLI harness (`--dir <consumer> --variant <variant>`) exercising `check-product-quality.mjs` against four hand-written behaviors without model dispatch:
  - Positive control: `valid` variant (implements `summarizeOrder` and `applyRefund` with safe-integer arithmetic, bounds checking, and immutability; expects exit 0, `requirementsSatisfied: true`, 0 failures).
  - Negative controls: `baseline` variant (unextended module; fails `R02-refund-export`), `broken-total` variant (omits refund deduction; fails `R02-refund-total`), and `broken-boundary` variant (omits input guards; fails `R03-reject-refund-unknown-item`, `R02-over-remaining-refusal`).
- **Negative-vs-Positive Control Pairing**:
  - *Review discrimination*: Positive defect scenarios (`setup-review-positive.mjs`, `setup-defect-outcome.mjs`) introduce latent dispatcher/router omissions and helper antipatterns; paired against negative near-neighbor control (`setup-near-negative.mjs`) requiring an `ACCEPT` verdict with zero false-positive findings.
  - *Consumer check discrimination*: `control-product-quality.mjs` pairs positive `valid` implementation against three negative variants (`baseline`, `broken-total`, `broken-boundary`), plus ambient missing/broken-checker controls in `tools/tests/product-quality-consumer.test.mjs`.
  - *Harness smoke discrimination*: `smoke/baseline/result.json` (all runs pass) paired with `smoke/candidate/result.json` (injected red failure on `eval-verdict-parsing`, green on `eval-frozen-test-invariance`).
- **Canned Benchmark Smoke Fixtures (`smoke/`)**:
  - `smoke/baseline/result.json`: Reference 10-run result array across `eval-verdict-parsing` and `eval-frozen-test-invariance` with all checks passing.
  - `smoke/candidate/result.json`: Candidate 10-run result array with deliberate check failures on `eval-verdict-parsing` to exercise red exit status.

## Data & Control Flow
1. **Benchmark Model Run Setup**:
   - `tools/benchmark.mjs` or `tools/run-skill-benefit-eval.mjs` creates an isolated run directory and workspace.
   - Runner iterates `task.setup` array from `bench/tasks.json`, spawning `node bench/fixtures/setup-*.mjs` with `cwd: repoDir`.
   - Setup script creates files (`manifest.md`, `src/*`, optional `tests/*`) and commits deterministic Git revisions.
   - Runner records `baseSha` (`git rev-parse HEAD`), writes `prompt.txt`, and dispatches to model runner (`tools/bench-session-runner.ts`).
   - Post-run, the corresponding checker in `bench/checks/` (`check-positive.mjs`, `check-near-negative.mjs`, `check-defect-outcome.mjs`, `check-workflow-outcome.mjs`, `check-product-quality.mjs`) grades workspace artifacts into `bench/runs/`.
2. **Behavioral Control Execution**:
   - `control-product-quality.mjs` resolves target `--dir`, verifies required arguments, and selects variant source code.
   - Injects variant source into `<dir>/src/order-summary.mjs` and sets `BENCH_CONSUMER_DIR: dir`.
   - Spawns sibling checker `bench/checks/check-product-quality.mjs` via `node` child process.
   - Parses checker stdout JSON, evaluates exit code (`status === chosen.exit`), verifies `requirementsSatisfied`, and asserts designated failure IDs (`mustFail`).
   - Emits structured JSON summary and sets `process.exitCode` (0 = discrimination passed, 1 = check failed, 2 = usage error).
3. **Harness Smoke Verification**:
   - `tools/benchmark.mjs smoke --baseline bench/fixtures/smoke/baseline --candidate bench/fixtures/smoke/candidate` reads both `result.json` files.
   - Evaluates aggregate task pass rates and asserts exit code 1 (red due to candidate regression) or exit code 0 when filtering for unaffected tasks.

## Integration Points
- **Task Manifest (`bench/tasks.json`)**: Configures fixture setup scripts under `task.setup` paired with respective checkers in `task.checks`:
  - `setup-review-positive.mjs` → `check-positive.mjs` (`eval-review-positive`).
  - `setup-near-negative.mjs` → `check-near-negative.mjs` (`eval-review-near-negative`).
  - `setup-defect-outcome.mjs` → `check-defect-outcome.mjs` (`eval-review-defect-outcome`).
  - `setup-workflow-outcome.mjs` → `check-workflow-outcome.mjs` (`eval-workflow-execution-outcome`).
  - `setup-product-quality.mjs` → `check-product-quality.mjs` (`eval-product-quality-consumer`).
- **Consumer Quality Regression Tests (`tools/tests/product-quality-consumer.test.mjs`)**: Directly invokes `control-product-quality.mjs` with `--variant` across temp roots, and verifies that `setup-product-quality.mjs` emits valid syntax in a clean Git repo.
- **Harness Smoke Tests (`tools/tests/benchmark.test.mjs`)**: Consumes `smoke/baseline/result.json` and `smoke/candidate/result.json` through `tools/benchmark.mjs smoke` to test regression reporting and task filtering.
- **Harness Drivers (`tools/benchmark.mjs`, `tools/run-skill-benefit-eval.mjs`)**: Orchestrates scenario setup, model execution via `tools/bench-session-runner.ts`, and artifact storage in `bench/runs/`.
