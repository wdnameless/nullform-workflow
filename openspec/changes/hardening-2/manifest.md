# Requirements — hardening-2 (T2)

User: «Приступай и найди проблемы и баги» (approval of the 9/10 roadmap: oracle protocol in the role, data-driven pruning, sync prune, isolation, oracle-lite, memory cadence — plus an explicit bug hunt).

| ID | Requirement | Acceptance | Status |
|---|---|---|---|
| R01 | Oracle protocol in the role | `agent/agents/oracle.md` carries the evidence protocol as a mandatory section: raw command output only, exact file paths + line numbers for every file claim, cwd discipline, ban on paraphrasing/translating, `NOT PROVEN` instead of guessing. `orchestrator.md`: when the resolved oracle model is flash-class (or fallback), T2 acceptance = **two independent passes** (oracle + second verifier) reconciled by the orchestrator; small T2 (≤2 files, ≤~80 diff lines) may use oracle-lite (single pass, same protocol). Weekly memory review line added | in-spec |
| R02 | Tool bug hunt | Adversarial edge-case tests across `debt-ledger`, `benchmark`, `usage-audit`, `domain-context`, `context-inbox`, `oracle-model`, `prompt-lint sizes`; every reproduced defect fixed in place with a regression test; each finding recorded as repro → cause → fix | in-spec |
| R03 | Infra bug hunt + sync prune | `doctor` gains an orphan-file check (harness files absent from the repo for manifest-covered dirs) and `sync.ps1` gains `-Prune` (dry-run listing by default, `-Confirm` to delete); infra defects fixed with tests | in-spec |
| R04 | Skills disable-list + pruning | `~/.agents/.skills-disabled.json` (names) honored by `skills-doctor` (disabled = informational, not a problem) and by the installer's skip logic; unused skills (90-day usage audit) moved to `~/.agents/skills-disabled/`; the garbage `test-mcp-renamed-2` entry removed from the live `mcp.json` | in-spec |
| R05 | Docs | README + CONTEXT.md updated: double acceptance, oracle-lite, disabled skills, sync prune | in-spec |
| R06 | First real benchmark | ≥2 tasks × 2 arms (one-shot vs process-disciplined prompt) × n≥1 executed with `omp -p` on a throwaway repo; raw results + `report`/`compare` archived under `openspec/changes/hardening-2/benchmark/`; interpretation states sample size honestly | in-spec |
| R07 | No regressions | node/python/verify/audit/portability green; doctor 8/8; prompt sizes within budget; baselines refreshed after the prompt edits | in-spec |

Non-goals: strengthening the oracle model itself (omniroute is unreachable — the fallback stays, now guarded by double acceptance); deleting skills from the repo (only the live registry is trimmed); auto-pruning without a dry run.

Assumptions (stated): `omp -p` is the benchmark runner for R06; flash-class = resolved oracle model matching `*flash*` or the fallback entry.
