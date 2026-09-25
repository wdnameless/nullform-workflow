# Recon — Post-remediation audit

Second audit of the tree, scoped to what changed since the first: the four commits on master
(d9d4c7f..HEAD). Three independent reviewers audited the three highest-risk zones; every claim
was re-verified by a command in this session before being accepted.

## Verdict

The tree is green (381/381 tests, verify 29/29, audit 15/15) but the new code carries real
defects. The audit's own fixes introduced defects — precisely the class the first audit was
about. Below: what survived verification, and what was refuted.

## Confirmed defects (reproduced)

### In the new `tools/sync.mjs` (subagent-written, only reconciled by the orchestrator)

| # | file:line | Defect | Verified |
|---|---|---|---|
| S1 | `:252-277` | **Partial mutation on refused promote.** The loop writes a file, then checks whether a *later* file is suspect, then exits 2 "REFUSED" — but the earlier write already landed. Fix: two passes — collect all suspects, THEN write. | `sed -n 240,280p` read |
| S2 | `:293` | **Missing-file silent skip.** The OMP law parity check `if (existsSync(ompAgents) && existsSync(harnessAgents))` skips when the OMP copy is absent — so a missing `~/.omp/agent/AGENTS.md` reports "clean" and `--deploy` never restores it. Reproduced in a sandbox: a repo/harness pair with no OMP copy printed `sync: clean` with no mention of the missing file. | `sync.mjs --check` sandbox, exit 0 |
| S4 | `:133-157` | **Silent fallback on invalid explicit root.** `resolveRepoRoot` with a bad explicit `--repo` path falls through to candidates and ends at `path.resolve(__dirname, '..')` — the harness repo itself. An invalid path should be an error, not a fallback to a different repository. | read |
| S5 | `:286` | **`--json` is broken by drift output.** Drift lines are written to stdout even when `--json` is passed, so the JSON block is prefixed with plain text and `JSON.parse` of the output fails. Reproduced: `--json` printed `[XX] DRIFT …` lines before the `{`. | sandbox, `--json` run |
| S6 | manifest | **The manifest does not ship the tools that run it.** `sync-manifest.json` omits `tools/sync.mjs` and `tools/sync-manifest.json`, so a fresh install that depends on `sync.sh`/`sync.ps1` gets wrappers that call a missing engine. | manifest read |

### In the new `tools/code-size.mjs` (subagent-written)

| # | file:line | Defect | Verified |
|---|---|---|---|
| C1 | `:201-205` | **Multiline method signatures bypass the function limit.** The method regex requires the parameter list and the opening brace on the same line, so a 200-line method split across lines is invisible. Reproduced: `handle(a,\n b\n)\n{ …200 lines… }` produced zero offenders. | sandbox scan |
| C2 | `:212` | **Template literals and block comments are parsed as functions.** A multiline template containing `function fakeFn() { …131 lines… }` is reported as a real function. Reproduced: scan reported `fakeFn(): 132 строк` from a template literal. | sandbox scan |
| C3 | `:401-425` | **Baseline churn.** `generatedAt` changes on every `baseline` run, forcing a dirty git diff even when nothing changed. Function keys ARE lexicographically sorted (the subagent's claim they are not is refuted) — only the timestamp churns. | two identical runs, `diff` shows only the timestamp |

### In my own Phase-1/2-5 edits

| # | file:line | Defect | Verified |
|---|---|---|---|
| E1 | `tools/workflow.mjs:472-489` | **PID liveness is not responsiveness.** `process.kill(pid, 0)` reports a hung or breakpoint-stopped server as alive; the dashboard then prints a URL that does not answer. Improvement over nothing, but it claims more than it measures. | `process.kill` semantics |
| E2 | `tools/sync-prune.mjs:71` | **`HOST_CONFIG` misses `oracle-priority.json` while the doc comment names it.** `agent/oracle-priority.json` (operator-set oracle model) is not in the `(config|mcp|models)` set, so it would be reported as a prune orphan. The same regex over-protects `templates/ci/config.yml` and `tools/config.json` (no such files exist, but the scope is wrong). | `HOST_CONFIG.test` run |
| E3 | `agent/agents/orchestrator.md:34-35` | **Prompt surface drifted from the new dashboard rule.** I updated `agent/AGENTS.md` to say "if browser_new_tab fails, say so", but `orchestrator.md` — the file AGENTS.md designates as the authoritative protocol — still says `MUST IMMEDIATELY call browser_new_tab` with no failure branch. | grep |
| E4 | `agent/agents/oracle.md:40` | **Cites a command that does not exist.** Rule 10 instructs the oracle to run `replay --strict`; there is no such binary — the real call is `node tools/replay.mjs verify --cassette <file> --strict`. | `which replay` exit 1 |

## Refuted claims (recorded so they are not re-raised)

| Claim | Test | Result |
|---|---|---|
| Baseline function keys are unsorted | two identical runs, `diff` | **REFUTED** — keys sort correctly; only `generatedAt` churns (kept as C3) |
| PID liveness is insufficient | — | **PARTIALLY UPHELD** — E1 kept; PID existence is a real improvement over nothing but does not prove responsiveness |

## What this audit is NOT

- Not a re-read of the whole tree. The 27 defects from the first audit stay closed; this round
  reads only the 4 commits that changed since.
- Not a claim that the fixes hold forever. This audit is the proof that fixes need acceptance
  of their own.

## Fix reconciliation

R30–R42 were implemented after this audit. The sync and code-size fixes were written in
disjoint zones and independently smoke-tested by the integration owner:

- A refused multi-file promote left the earlier repo file unchanged; the former loop
  could write it before refusing on a later, newer repo file.
- An absent `~/.omp/agent/AGENTS.md` was reported as drift and restored by deploy.
- With drift present, `sync.mjs --json` wrote parseable JSON on stdout and diagnostic
  lines on stderr. An invalid explicit `--repo` exited 2.
- A 200-line multiline method was measured; `function fakeFn()` text inside a template
  was not. Two identical code-size baselines were byte-identical.
- Workflow start with a stale runtime file naming a live PID and dead port printed a
  different URL; a fetch of its `/api/health` returned `ok: true` and the runtime PID.
- Prune's test fixture protects operator-owned `agent/oracle-priority.json` but still
  reports template/tool config candidates outside `agent/`.
- The installed doctor now requires `sync.mjs` and `sync-manifest.json`, not only the
  two wrapper scripts.

Focused checks: sync regressions **3/3**, code-size regressions **19/19**, workflow
regressions **40/40**, doctor missing-engine check **1/1**, prune boundary **1/1**.
Full suite **389/389**; `verify` **29/29**, audit **15/15** on the deployed tree.
The existing code-size baseline ceiling for `tools/doctor.mjs` was raised by three lines
with a written reason: requiring the new engine and manifest closes a false pass.
