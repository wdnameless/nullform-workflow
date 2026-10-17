# bench/checks/

## Responsibility
Scoring and grading oracle layer for the benchmark evaluation harness. Evaluates candidate and baseline agent runs against synthetic safety-tier tasks, determining whether model responses and mutated repository artifacts satisfy the benchmark scenario's intent.

## Design Patterns
- **Strategy / Scenario Grader**: Discrete grading strategies per benchmark intent:
  - `check-positive.mjs` (`eval-review-positive`): Grades pre-merge review; requires detecting unhandled `pause` events in consumer `src/dispatcher.ts` and `src/utils.ts` padding simplification without false positives.
  - `check-near-negative.mjs` (`eval-review-near-negative`): Grades near-neighbor blind acceptance; requires `ACCEPT` verdict on observed manifest/runs with zero false-positive code findings.
  - `check-defect-outcome.mjs` (`eval-review-defect-outcome`): Grades release review; requires detecting unhandled `ExportReport` commands in `src/router.ts` and `src/utils.ts` clone simplification.
  - `check-workflow-outcome.mjs` (`eval-workflow-execution-outcome`): Grades autonomous code implementation; enforces frozen test invariance, runtime arithmetic checks, and return contract compliance.
- **Normalized Verdict Envelope**: Checkers persist a structured outcome (`requirementsSatisfied`, `scenario`, `activation`, `failures`, `findings`) to `score.json` via `writeScore` from `tools/bench-results.mjs` and set `process.exitCode` (0 = pass, 1 = fail).
- **Multi-Vector Oracle Probe**: `check-workflow-outcome.mjs` combines SHA-256 test snapshot verification (`verifyFrozenTests`), TAP test execution, dynamic module import, return-contract parsing (`validateReturnContract`), and native session tool-call auditing.

## Data & Control Flow
1. Harness runner (`tools/benchmark.mjs` or `tools/run-skill-benefit-eval.mjs`) exports `BENCH_RUN_DIR` (untracked run output directory) and invokes the checker command.
2. Review checkers call `extractFinalAssistantResponse` to read `input.json` and extract the terminal text from `session/*.jsonl`.
3. `scoreReview` evaluates assistant JSON reports against scenario expectations (consumer defect detection, helper simplification, or blind acceptance).
4. `check-workflow-outcome.mjs` verifies `frozen-tests.json` digest against `tests/calc.test.mjs`, runs tests, imports `src/calc.mjs` for edge-case checks, validates return contract, and verifies `write` tool usage.
5. `writeScore` writes the final score object to `score.json` in `BENCH_RUN_DIR`, logs JSON to stdout, and sets process exit code.

## Integration Points
- **Benchmark Tasks**: Wired to task IDs in `bench/tasks.json` via the `checks` command array.
- **Fixture Counterparts**: Evaluates repositories initialized by `bench/fixtures/` (`setup-review-positive.mjs`, `setup-near-negative.mjs`, `setup-defect-outcome.mjs`, `setup-workflow-outcome.mjs`).
- **Harness & Shared Utilities**: Executed by `tools/benchmark.mjs` and `tools/run-skill-benefit-eval.mjs`; imports scoring primitives from `tools/bench-results.mjs` and contract parser from `tools/return-contract.mjs`.
