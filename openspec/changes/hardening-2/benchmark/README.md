# First real benchmark — one-shot vs process discipline

Sample: 2 tasks × 2 arms × n=2 runs = 8 runs. Model: `deepseek-v4.1-flash` via `omp -p`
(non-interactive). Raw per-run `result.json` files are in `runs/` (one file per run, named by run id),
`report.txt` and `compare.txt` are the tool's own output on this dataset.

## Design

- Fixture repo: `D:/TMP/bench-real` (throwaway git repo, two tasks committed).
- Task `csv-sum`: implement `src/csv.js#sumColumn` so `node --test test/csv.test.js` passes.
- Task `pagination-fix`: fix an off-by-one in `src/pagination.js` so `node --test test/pagination.test.js` passes.
- Arm `oneshot`: the task prompt alone.
- Arm `process`: the same prompt with a discipline preamble prepended (run the check first,
  smallest change, no new files/tests, re-run the check, mark deliberate ceilings with a `defer:` marker).
- Each run executes in a fresh `git clone --local` of the fixture; checks run inside that clone.

## Result (median per cell)

| Task | Arm | Runs | Time | LOC | Files | Checks |
|---|---|---|---|---|---|---|
| csv-sum | oneshot | 2 | 22.8s | +43 | 1 | 2/2 |
| csv-sum | process | 2 | 16.7s | +26 | 1 | 2/2 |
| pagination-fix | oneshot | 2 | 10.3s | +1/-1 | 1 | 2/2 |
| pagination-fix | process | 2 | 10.1s | +1/-1 | 1 | 2/2 |

Aggregate: **−38.6% lines, −18.9% time, checks 4/4 → 4/4**.

## Honest interpretation

- The discipline preamble cut the feature task's diff by ~40% and time by ~27%; on the bug-fix task
  both arms produced the same one-line change, so the discipline was neutral there.
- **n=2 per cell on 2 toy tasks is not statistical evidence.** It is directionally consistent with the
  reference benchmark (−54% LOC) but must not be quoted as proof. The value of this run is that the
  instrument now produces *measurable, reproducible* numbers with raw artifacts attached.
- No quality difference was observable: all 8 runs passed their checks. The safety dimension
  (adversarial tasks where a lazy solution breaks something) is **not covered** yet.
- Two defects in the harness itself were found by this run and fixed before the numbers above were taken:
  (1) metrics silently reported zero when `git add -A` failed (agent work vanished from the report), and
  (2) tool-generated directories (`.opencode/**`, ~7 files / ~1045 lines per run) were counted as the
  agent's work. `result.json` now carries `metricsWarning`, `toolArtifacts`, `baseSha/headSha/commits`.
- Cost per run was not captured: `omp -p` sessions are not persisted under `~/.omp/agent/sessions`,
  so `session_cost.py` had nothing to read. Wiring cost requires a persisted transcript path.
