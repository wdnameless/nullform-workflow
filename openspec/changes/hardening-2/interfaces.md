# Interfaces and ownership — hardening-2

## R01 prompt surfaces (owner: A)
- `agent/agents/oracle.md`: new section **EVIDENCE PROTOCOL (mandatory)** — (1) every claim about a file = exact path + line number + verbatim quote from a command output; (2) every behavioural claim = the executed command + its raw output (counts and exit codes as printed); (3) commands run with an explicit cwd; the session directory is not the repo; (4) no translation, no paraphrase, no "expected" output; if a check cannot run → `NOT PROVEN` + reason; (5) a summary number that does not appear verbatim in raw output invalidates the report. Keep the existing output shape.
- `agent/agents/orchestrator.md`: Wave 4 gains — *flash-class oracle* (resolved model matches `*flash*` or the configured fallback) → run **two independent acceptance passes** and reconcile (agreement required for ACCEPT; either `REJECT` forces a fix round); *oracle-lite* allowed only when the slice touches ≤2 files and the diff is ≤~80 lines — single pass, same protocol. Add the weekly memory review line to the MEMORY section (AGENTS.md or orchestrator per fit).
- Docs: `README.md` (new bullets under the oracle/review area: double acceptance, oracle-lite, `sync -Prune`, disabled skills) + `CONTEXT.md` terms **Double acceptance**, **Oracle-lite**, **Disabled skill**, **Prune**.

## R02 tool bug hunt (owner: B; files below only)
Adversarial pass over: `tools/debt-ledger.mjs`, `tools/benchmark.mjs`, `tools/usage-audit.mjs`, `tools/domain-context.mjs`, `tools/context-inbox.mjs`, `tools/oracle-model.mjs`, `tools/prompt-lint.mjs` (+ their test files).
Rules: a fix requires a REPRODUCED defect (command + wrong output) and a regression test that fails before and passes after. Cosmetic changes are out of scope. Each finding in the return: `repro → cause → fix → test`.
Suggested attack surface (not exhaustive): `--runs 0/-1`, missing/unknown task id, `--top 0`, `--days 0`, malformed `bench/tasks.json`, non-existent `--sessions` dir, empty `SKILL.md` frontmatter, budget.json with wrong types/negative values, unicode in marker/task ids, `--write` to a directory, duplicate task ids, `compare` with one arm, JSON mode on error paths, long lines (>1 MB single line), CRLF+BOM combos.

## R03 infra bug hunt + prune (owner: C; files: tools/doctor.mjs, tools/sync.ps1, tools/tests/doctor.test.mjs, tools/tests/test-sync-guard? — create/extend tests you own)
- `doctor.mjs`: new check `orphan-files` — for manifest-covered directories (`tools/`, `agent/`, `rules/`, `core/`, `templates/`, `paseo/`), list harness files that do NOT exist in the repo tree when a repo clone is discoverable; status FAIL for files under `tools/`, WARN otherwise; JSON as usual. Add tests (fixture with an extra file → FAIL/WARN; clean tree → PASS).
- `sync.ps1`: new switch `-Prune` — compute harness files absent from the repo within manifest-covered dirs, print them (`prune: N candidate(s)`), delete ONLY with `-Confirm`; never touches `.prompt-lint`, `.workflow`, `.archmap`, `node_modules`, `worktrees`, session or config files. Support `-WhatIf` semantics by default (no deletes). Also fix any defect you reproduce in sync/doctor with a test.
- Adversarial pass on `workflow.mjs` (state corruption, double `start`, `close` without artifacts, `metrics` with malformed lines) — fixes only where reproduced.
- **Provider reachability (added after the live blocker)**: `doctor.mjs` gains `--probe` (opt-in, network) that checks each configured provider in `models.yml` for reachability and each role in `config.yml` for pointing at a reachable model; unreachable → WARN with the role names listed (never FAIL — the machine may be offline). `oracle-model.mjs` gains the same reachability awareness: `list --probe` marks unreachable providers and `ensure --probe` SHALL NOT select a model whose provider failed the probe. Live evidence for this requirement: all four subagent roles pointed at `nullform-gateway/gemini-3.8-flash-high`, the gateway returned `429 All accounts exhausted`, and every spawn died — with no warning from doctor, audit or oracle-model.

## R04 registry pruning (owner: D; files: tools/skills-doctor.mjs + live environment)
- `skills-doctor.mjs`: read `<agentsHome>/.skills-disabled.json` (`{version, disabled: [names], note?}`); skills listed there are reported as `info: disabled by operator` and are NOT counted as orphans/parity problems; add a `--agents-home <dir>` flag defaulting to `<installed root>/..`.
- Live pruning (D performs it, with a copy of the list in the return): using the 90-day usage audit, move unused skills from `C:/Users/Administrator/.agents/skills/<name>` to `C:/Users/Administrator/.agents/skills-disabled/<name>` and write the JSON list; keep `install.ps1`'s lock-managed skip logic working (lock-managed skills that are moved stay skipped by path check).
- `mcp.json` (live at `C:/Users/Administrator/.omp/agent/mcp.json`): remove the `test-mcp-renamed-2` entry (back it up to `mcp.json.removed.json`). Do NOT touch other servers without operator approval — list them with 90-day usage counts in the return instead.
- Tests: fixture skills roots + disabled list → no problems; disabled name absent from disk → still not a problem; malformed JSON → falls back to empty list (warn).

## R05 docs (owner: A, same worker as R01)

## R06 benchmark run (owner: Main)
Throwaway repo `D:/TMP/bench-real/` with 2 tasks (deterministic checks). Arms:
- `oneshot`: `omp -p "<prompt>" --auto-approve --no-title`
- `process`: same + discipline paragraph (test-first, minimal diff, simplify, `defer:` marker for shortcuts).
n=1 each (honest sample size), flash-class model. Raw `result.json`s + `report`/`compare` archived under `openspec/changes/hardening-2/benchmark/`.

## Ownership
- A (task): agent/agents/oracle.md · agent/agents/orchestrator.md · agent/AGENTS.md · README.md · CONTEXT.md
- B (fixer): the 7 tools + their test files listed in R02
- C (fixer): tools/doctor.mjs · tools/sync.ps1 · tools/tests/doctor.test.mjs · tools/tests/sync-prune.test.mjs (new)
- D (fixer): tools/skills-doctor.mjs · live `~/.agents` move + `mcp.json` garbage entry · tests
- Main: openspec artifacts · benchmark run · integration (suites, doctor, sizes, baselines) · oracle (double pass) · git
