# Interfaces and ownership — benchmark-harness

## tools/benchmark.mjs (new; zero deps, Node 18+, ESM, RU output)
Library exports:
- `export const TASKS_FILE = "bench/tasks.json"`, `export const RUNS_DIR = "bench/runs"`
- `export function initBenchmark(root)` → `{created: string[], skipped: string[]}` — writes `bench/tasks.json` (template with one example task), `bench/README.md`, `bench/.gitignore` (`runs/`); idempotent.
- `export function loadTasks(root)` → `{version, tasks}` (throws on malformed).
- `export function runBenchmark({root, taskId, arm, cmd, runs, timeoutSec, transcript, yes, dryRun})` → plan | results[]
- `export function summarizeRuns(root)` → `{byTaskArm: {...}, total}` (reads `bench/runs/*/result.json`)
- `export function compareArms(summary, baselineArm, candidateArm)` → per-task deltas + aggregate
- `export function parseArgs(argv)`
CLI:
- `node tools/benchmark.mjs init --root <dir>`
- `node tools/benchmark.mjs list --root <dir> [--json]`
- `node tools/benchmark.mjs run --root <dir> --task <id> --arm <name> --cmd "<template>" [--runs N] [--timeout <sec>] [--transcript <path>] [--dry-run] [--yes]`
- `node tools/benchmark.mjs report --root <dir> [--json]`
- `node tools/benchmark.mjs compare --root <dir> --baseline <arm> --candidate <arm> [--json]`

Run mechanics (frozen):
- Must run from a git `--root` (else exit 2 with a clear RU message).
- Per run: `bench/runs/<UTC-ts>-<taskId>-<arm>-<n>/repo` = `git clone --quiet --local <root> <path>`; setup commands run inside `repo`; the arm command runs inside `repo` with env `BENCH_TASK_PROMPT` (task text), `BENCH_RUN_DIR`, `BENCH_ARM`, `BENCH_RUN_ID` and placeholders substituted; stdout+stderr → `agent.log`; timeout → kill + status `timeout`.
- Metrics: `git -C repo add -A` then `git -C repo diff --cached --numstat HEAD` → per-file `{added, deleted, file}`; totals `linesAdded`, `linesDeleted`, `filesChanged`.
- Checks: each runs inside `repo`; `{cmd, code, passed, tail}`.
- Cost (optional): when `--transcript <path>` resolves, call `python tools/session_cost.py <path> --json` (python3 → python fallback); store parsed JSON under `result.cost`; on failure store `{note: "…"}` — never fail the run.
- `result.json` keys (frozen): `{version:1, task, arm, run, startedAt, durationMs, status: "ok"|"timeout"|"error", agentExit, metrics:{linesAdded,linesDeleted,filesChanged,files:[…]}, checks:[…], cost?, logPath}`.

Report/compare (frozen):
- `report`: table per task×arm: `runs`, `medianDurationMs`, `linesAdded`/`linesDeleted` (median), `filesChanged`, `checks: passed/total`, `cost` (if any). No runs → `Запусков нет: сначала выполните benchmark run.` exit 0.
- `compare`: per task `baseline → candidate` with `%` for linesAdded and durationMs, plus checks pass rate; aggregate line `Итог: −X% строк, −Y% времени, checks A→B` (omits metrics with no baseline data).

## Wiring (frozen)
- `tools/sync.ps1`: manifest gains `'tools\benchmark.mjs',` next to debt-ledger.
- `tests/test-portability.ps1`: Assert that `tools\benchmark.mjs` installs (next to debt-ledger).
- `tools/audit.ps1`: `Invoke-Check 'benchmark tool'` mirroring `'debt ledger tool'` (missing → `Ok=$false`). Audit count 10 → 11.

## Docs
- `README.md`: section «Замеры ценности (benchmark)» — concepts (task/arm/run/check), quickstart (`init` → `run --dry-run` → `run --yes` → `report` → `compare`), placeholders/env table, honest note: the harness measures, the agent runner is user-supplied; cost only when a transcript path is given.
- `CONTEXT.md`: **Benchmark task** and **Arm** terms under Engineering disciplines + tooling entry `tools/benchmark.mjs`.

## Tests (tools/tests/benchmark.test.mjs, node:test)
Temp git repo fixture (git init, one committed file) + portable node runner (`node -e` writing files) + tasks.json. Cases: metrics (2 added lines, 1 file) · check pass · check fail → exit code recorded, `checks[].passed=false` · refusal without `--yes` · `--dry-run` writes nothing · `compare` math on synthetic runs · non-git root exit 2 · `report` empty exit 0.

## Ownership (one writer per file)
- Worker1 (fixer): tools/benchmark.mjs · tools/tests/benchmark.test.mjs
- Worker2 (fixer): tools/sync.ps1 · tools/audit.ps1 · tests/test-portability.ps1
- Worker3 (task): README.md · CONTEXT.md
- Main: openspec artifacts · integration · oracle · git
