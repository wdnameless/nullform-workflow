# bench/checks/

## Responsibility
Scoring and grading oracle layer for the benchmark evaluation harness. Evaluates candidate and baseline agent runs against synthetic safety-tier tasks, determining whether model responses, transcripts, and mutated repository artifacts satisfy scenario intent. Houses discrete assertion checkers for pre-merge review diffs, blind acceptance, defect outcome detection, workflow execution invariance, and runtime consumer product quality.

## Design Patterns
- **Strategy / Scenario Grader**: Discrete CLI grading strategies per benchmark intent:
  - `check-positive.mjs` (`eval-review-positive`): Grades pre-merge code review diffs. Asserts detection of unhandled `pause` events in `src/dispatcher.ts` and padding helper simplification in `src/utils.ts` without false positives.
  - `check-near-negative.mjs` (`eval-review-near-negative`): Grades near-neighbor blind acceptance. Asserts explicit `ACCEPT` verdict on observed manifest/runs and proven `R01`/`R02` requirements with zero false-positive code findings.
  - `check-defect-outcome.mjs` (`eval-review-defect-outcome`): Grades release review. Asserts detection of unhandled `ExportReport` commands in `src/router.ts` and clone helper simplification in `src/utils.ts` without false positives.
  - `check-workflow-outcome.mjs` (`eval-workflow-execution-outcome`): Grades autonomous code implementation. Asserts pre/post test byte invariance against `frozen-tests.json` digest, TAP passing counts (`# pass 2`), runtime arithmetic edge cases on `src/calc.mjs` (`add`, `multiply`), valid return contract (`validateReturnContract`) with `DONE` or `DONE_WITH_CONCERNS`, and native session `write` tool usage.
  - `check-product-quality.mjs` (`eval-product-quality-consumer`): Grades bounded maintenance consumer behavior by dynamically importing `src/order-summary.mjs` without inspecting transcripts or source strings. Asserts:
    - `R01`: baseline positive-order summary preserved (`summarizeOrder({ items })` returns subtotal 3500, tax 700, total 4200 cents).
    - `R02`: refund handling added and recorded (`applyRefund` export, single refund 4200 -> 3700, sequential in-order refunds 4200 -> 3200 -> 3000, and refusal of over-remaining refunds larger than balance).
    - `R03`: invalid input boundary rejections without corruption, coercion, or wrap (negative price, zero quantity, non-integer price/qty, unsafe integer `2**60`, overflowing product `2**30 * 2**30`, unknown refund itemId, and invalid refund amounts).
    - `R04`: declared finite workload (50,000 items) producing exact independent totals (subtotal 15,575,000, tax 3,115,000, total 18,690,000 cents) within a 5,000ms fixture smoke ceiling.
- **Check-Result Contract & Normalized Verdict Envelope**: Each checker returns a structured result contract:
  - Review checkers (`positive`, `negative`, `defect`): `{ scenario: string, activation: boolean, missedDefects: number, falsePositives: number, simplificationIdentified?: boolean, requirementsSatisfied: boolean, findings: Array<{ file_path: string, title: string, body: string }> }` (or `{ requirementsSatisfied: false, error: string }`).
  - Workflow checker: `{ scenario: "workflow", requirementsSatisfied: boolean, failures: string[] }`.
  - Product-quality checker: `{ scenario: "product-quality-consumer", requirementsSatisfied: boolean, failures: string[], checks: Array<{ id: string, ok: boolean, detail: string }>, measured: { workload: string, elapsedMs: number, limits: string, environment: { node: string, platform: string, arch: string }, expected: object, result: object }, limits: string }`.
  - Checkers persist outcomes via `writeScore(name, result)` from `tools/bench-results.mjs` to `score.json` in `process.env.BENCH_RUN_DIR`, log JSON to stdout, and set `process.exitCode` (0 = pass, 1 = fail). `check-product-quality.mjs` also supports standalone execution without `BENCH_RUN_DIR`, outputting JSON directly and setting `process.exitCode`.

## Data & Control Flow
1. Benchmark harness (`tools/benchmark.mjs` or `tools/run-skill-benefit-eval.mjs`) reads task definitions from `bench/tasks.json` and provisions `BENCH_RUN_DIR` (e.g., `bench/runs/<timestamp>-<taskId>-<variant>/`).
2. Harness spawns fixture scripts from `task.setup` (`bench/fixtures/setup-*.mjs`) with `cwd` set to the task run workspace (`repoDir`) to seed files, commit history, and write `frozen-tests.json` / `manifest.md`.
3. Evaluated model session executes via `tools/bench-session-runner.ts`, generating tool calls, modifying workspace files, and logging transcript events to `session/*.jsonl`.
4. Harness invokes checker command(s) specified in `task.checks` (e.g. `node bench/checks/check-*.mjs`) via child process with `cwd` set to evaluated workspace. For `check-product-quality.mjs`, `BENCH_CONSUMER_DIR` optionally overrides candidate directory (defaulting to `cwd`).
5. Grader execution:
   - Review checkers call `extractFinalAssistantResponse()` to parse `input.json` and `session/*.jsonl`, then invoke `scoreReview()` against findings report JSON.
   - `check-workflow-outcome.mjs` validates test sha256 via `verifyFrozenTests`, spawns `node --test` TAP runner, imports `src/calc.mjs` for edge calculations, validates terminal contract via `validateReturnContract`, and confirms session `write` tool calls.
   - `check-product-quality.mjs` dynamically imports `src/order-summary.mjs`, runs test assertions `R01`–`R04`, records pass/fail checks, and measures workload execution time via `process.hrtime.bigint()`.
6. Result emission: `writeScore` writes the final score object to `score.json` in `BENCH_RUN_DIR`, prints JSON to stdout, and sets process exit code (0 for pass, 1 for fail). In standalone mode, `check-product-quality.mjs` prints JSON and sets exit code directly.
7. Harness inspects process exit code and `score.json` to record pass/fail outcomes in benchmark run ledgers.

## Integration Points
- **Benchmark Tasks**: Registered under `checks` command arrays in `bench/tasks.json` (`eval-review-positive`, `eval-review-near-negative`, `eval-review-defect-outcome`, `eval-workflow-execution-outcome`, `eval-product-quality-consumer`).
- **Fixture Counterparts**: Paired 1:1 with repository setup fixtures in `bench/fixtures/` (`setup-review-positive.mjs`, `setup-near-negative.mjs`, `setup-defect-outcome.mjs`, `setup-workflow-outcome.mjs`, `setup-product-quality.mjs`).
- **Deterministic Control Runner**: Exercised directly by `bench/fixtures/control-product-quality.mjs` and regression test `tools/tests/product-quality-consumer.test.mjs`, asserting that `check-product-quality.mjs` accurately discriminates valid and broken consumer variants without LLM inference.
- **Harness & Shared Utilities**: Invoked by `tools/benchmark.mjs` and `tools/run-skill-benefit-eval.mjs`; imports scoring primitives, session transcript parsers, and frozen test verifiers from `tools/bench-results.mjs` (`extractFinalAssistantResponse`, `scoreReview`, `verifyFrozenTests`, `writeScore`) and contract parser from `tools/return-contract.mjs` (`validateReturnContract`).
