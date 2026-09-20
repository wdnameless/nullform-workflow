# Requirements — benchmark harness (T2)

User: «Следующий шаг по желанию: P2 — бенчмарк-харнесс для замера ценности воркфлоу (−LOC/токены/время/безопасность) — отдельной инициативой, как договаривались.» → «Делай».

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Task/arm/run model | `bench/tasks.json` schema `{version, tasks:[{id,title,prompt,setup?,checks?,timeoutSec?}]}`; arm = named runner command template with placeholders `{prompt_file}`,`{run_dir}`,`{task_id}`,`{arm}` and env `BENCH_TASK_PROMPT`,`BENCH_RUN_DIR`,`BENCH_ARM`,`BENCH_RUN_ID`; each run executes in a fresh clone (`git clone --quiet --local`), so arms never see each other's state | in-spec |
| R02 | Measured metrics | Per run `result.json`: agent exit code, durationMs, `linesAdded`/`linesDeleted`/`filesChanged` from `git add -A` + `git diff --cached --numstat HEAD`, per-check pass/fail with output tail, agent log path; optional cost block when a transcript path is supplied and `session_cost.py` can read it (graceful note otherwise) | in-spec |
| R03 | Safety seam | `run` refuses without `--yes`; `--dry-run` prints the plan and executes nothing; non-git `--root` → exit 2; timeouts kill the run and mark it `timeout` | in-spec |
| R04 | Report & compare | `report` aggregates runs by task×arm (runs, median duration, lines ±, files, checks passed/total, cost) in RU text or `--json`; `compare --baseline <arm> --candidate <arm>` prints per-task deltas plus one aggregate line; zero runs → honest empty report, exit 0 | in-spec |
| R05 | Self-testable | `node --test tools/tests/benchmark.test.mjs` covers: metrics capture, check pass/fail, refusal without `--yes`, dry-run makes no files, report/compare math, non-git root exit 2 — all against a temp git fixture with a portable node runner (no models, no network) | in-spec |
| R06 | Wiring & docs | sync manifest ships the tool; test-portability asserts install; audit presence check; README section with concepts + example commands + the honest note that the agent/runner is user-supplied; CONTEXT.md terms *Benchmark task* and *Arm* | in-spec |
| R07 | No regressions | Existing suites stay green (node 73, python 8, verify 26, audit 10→11 with the new check, portability 11); prompt-lint baseline refreshed only if a prompt surface changed (it should not) | in-spec |

Non-goals: LLM judge (deterministic checks only in v1); spawning models itself; storing transcripts (paths are referenced, not copied); dashboards.

Assumptions (stated): benchmark runs operate on committed HEAD of the target repo (clean state per run); results live under `bench/runs/` which `init` gitignores.
