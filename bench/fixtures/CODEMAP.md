# bench/fixtures/

## Responsibility
Scenario construction and fixture factory for the benchmark harness. Materializes deterministic starting Git repository states (synthetic requirements manifests, seeded source trees, two-stage commit histories, and frozen tests) inside isolated runner workspaces that `tools/benchmark.mjs` hands to evaluated models.

## Design Patterns
- **Fixture Factory / Scenario Builder**: Standalone CLI scripts (`setup-review-positive.mjs`, `setup-near-negative.mjs`, `setup-defect-outcome.mjs`, `setup-workflow-outcome.mjs`, `setup-product-quality.mjs`) executed in target `process.cwd()`. They export no JS symbols; their implementation contract is:
  1. Create directory structure (`src/`, optional `tests/`).
  2. Write `manifest.md` containing requirement declarations (`R01`, `R02`, `R03`).
  3. Seed source files and commit via `git -c user.name="Bench" -c user.email="bench@example.com" commit`.
  4. For diff review: commit base (`HEAD~1`), then commit target patch (`HEAD`).
  5. Paired task registration in `bench/tasks.json` requires: `id`, `tier`, `title`, `candidateSkill`, `prompt`, `setup` (`["node bench/fixtures/setup-<name>.mjs"]`), `checks` (`["node bench/checks/check-<name>.mjs"]`), `timeoutSec`.
- **Synthetic Manifest Contract**: Standardizes scenario expectations via `manifest.md` table or list format consumed by blind-acceptance and review checks.
- **Two-Stage Commit Seeder**: Emits clean base commit (`HEAD~1`) followed by defect/change commit (`HEAD`) to construct realistic review diffs without manual Git plumbing.

## Data & Control Flow
1. Benchmark runner (`tools/benchmark.mjs`) creates `runDir` and clones repo into workspace `repoDir`.
2. Runner iterates `task.setup` array from `bench/tasks.json`, spawning `node bench/fixtures/setup-*.mjs` with `cwd: repoDir`.
3. Fixture script creates files (`manifest.md`, `src/*`, `tests/*`) and commits deterministic Git revisions.
4. Runner captures `baseSha` (`git rev-parse HEAD`), writes `prompt.txt`, and hands execution to model runner (`tools/bench-session-runner.ts`).
5. Agent work modifies workspace; runner invokes `bench/checks/check-*.mjs` to score outputs into gitignored `bench/runs/`.

## Integration Points
- **Task Manifest**: Registered in `bench/tasks.json` via task descriptor fields (`id`, `prompt`, `setup`, `checks`, `candidateSkill`, `timeoutSec`).
- **Runner Drivers**: Invoked by `tools/benchmark.mjs` and orchestrated via `tools/run-skill-benefit-eval.mjs` / `tools/bench-session-runner.ts`.
- **Evaluation Checks**: 1:1 pairing with verification scripts in `bench/checks/` (`check-positive.mjs`, `check-near-negative.mjs`, `check-defect-outcome.mjs`, `check-workflow-outcome.mjs`, `check-product-quality.mjs`).
- **Deterministic Control Runner**: `control-product-quality.mjs` writes a chosen behavior variant (valid / baseline / broken-total / broken-boundary) into a consumer root, runs the real sibling checker, and requires a specific exit code plus designated failure ids, so the checker is proven to discriminate behavior without any model dispatch.
- **Run Artifacts**: Seeds scratch trees inside gitignored `bench/runs/`.
