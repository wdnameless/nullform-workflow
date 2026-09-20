# Acceptance Oracle Report: tkach-adoption

- **Date**: 2026-09-20
- **Auditor**: PackOracle (blind acceptance oracle)
- **Manifest**: `openspec/changes/tkach-adoption/manifest.md`
- **Verdict**: **ACCEPT**

---

## Evaluation Summary by Requirement

| Requirement | Description | Status | Evidence Summary |
|---|---|---|---|
| **R01** | Stage B (Simplification) protocol | **PROVEN** | Quotes & line numbers from `orchestrator.md` (lines 66-70), `fixer.md` (lines 51-58), `reviewer.md` (line 99). |
| **R02** | Prompt Budget & PROMPT-OWNERSHIP | **PROVEN** | `prompt-lint.mjs sizes --root .` exit 0, `--check` exit 0; custom budget override failure (exit 1); `AGENTS.md` quote (line 43). |
| **R03** | Usage Audit CLI | **PROVEN** | Scanned 199 real sessions (exit 0); `--json` output structured without message bodies; empty session dir outputs `Сессий не найдено` (exit 0). |
| **R04** | Domain Context Decisions | **PROVEN** | Discovered ADRs and OpenSpec proposals under `DECISIONS` section; handles missing matches cleanly (`решений по домену не найдено`, exit 0). |
| **R05** | Context Checklist & Memory Hygiene | **PROVEN** | Quotes from `orchestrator.md` (lines 80-81, CONTEXT PACK >= 5 sources, noise rule) and `AGENTS.md` (line 33, durable facts -> `docs/adr`). |
| **R06** | Install Doctor CLI & Gate | **PROVEN** | Passed full install check (exit 0) and repo mode check (exit 0); broken harness detected with exit 1; called in `install.ps1` (lines 374-386) with `exit 1` on failure. |
| **R07** | Documentation & CONTEXT.md | **PROVEN** | README sections present; domain terms indexed in `CONTEXT.md` (lines 121-125). |
| **R08** | Regression & Suite Health | **PROVEN** | Node test suite: 13/13 passed (100 tests, 0 failures, exit 0); Python session cost: 8/8 passed (exit 0); `audit.ps1`: 14/14 PASS; `verify.ps1`: 27/27 PASS. |

---

## Detailed Evidence

### R01: Stage B (Simplification)
1. `agent/agents/orchestrator.md`:
   - Line 66: `Wave 3.5 (Stage B - Simplification, mandatory):`
   - Line 67: `- Dispatched after Wave 3 subagents report complete and reviewer produces tagged delete-list, BEFORE Wave 4 Oracle.`
   - Line 68: `- Dispatches @fixer in <stageB> mode with the delete-list and the instruction: delete obsolete code, inline single-use wrappers, preserve ALL existing tests green.`
   - Line 69: `- Invariant: test suite must remain 100% green throughout Stage B. If any test fails, revert the offending simplification.`
   - Line 70: `- Stage B must produce a net negative diff: net: -N lines (or net: 0 with zero new abstractions). If diff is net-positive, reject the simplification pass.`

2. `agent/agents/fixer.md`:
   - Line 51: `<stageB>`
   - Line 52: `Simplification mode (runs after initial green tests, before final acceptance):`
   - Line 53: `- Stage-A tests are FROZEN: never weaken, delete, or modify existing tests to accommodate simplification. All must stay green.`
   - Line 54: `- Flatten nesting and eliminate redundant indirection / forwarding layers.`
   - Line 55: `- Inline single-use helper functions and pass-through adapters.`
   - Line 56: `- Target: net negative line count while all tests stay green.`
   - Line 57: `- Zero new dependencies: solve with existing code, stdlib, or native platform primitives.`
   - Line 58: `</stageB>`

3. `agent/agents/reviewer.md`:
   - Line 99: `  Conclude the explanation with 'net: -N lines possible' or 'Lean already.'. This tagged delete-list is the input to Stage B.`

---

### R02: Prompt Size Budget & Prompt Ownership
1. Execution of `node tools/prompt-lint.mjs sizes --root .`:
   - Exit code: `0`
   - Raw output:
\`\`\`text
prompt-lint: prompt size budget analysis
  always       9.6 KB / max 16.0 KB      89 lines / max 200 lines  OK
  role-defs    48.7 KB / max 64.0 KB     881 lines / max 1200 lines OK
  rules        6.6 KB / max 16.0 KB      87 lines / max 250 lines  OK
  skills       22.2 KB / max 32.0 KB     136 lines / max 400 lines OK
\`\`\`

2. Execution of `node tools/prompt-lint.mjs sizes --check --root .`:
   - Exit code: `0`
   - Raw output identical to above with exit code 0.

3. Budget override verification via temporary `.prompt-lint/budget.json`:
   - Fixture at `D:/TMP/oracle_r02_test` without budget: exit `0`, all categories `OK`.
   - Fixture with `{"always": {"maxBytes": 100, "maxLines": 1}}`:
     - Command: `node tools/prompt-lint.mjs sizes --check --root D:/TMP/oracle_r02_test`
     - Exit code: `1`
     - Raw output:
\`\`\`text
prompt-lint: prompt size budget analysis
  always       9.6 KB / max 0.1 KB       89 lines / max 1 lines    EXCEEDED
  role-defs    48.7 KB / max 64.0 KB     881 lines / max 1200 lines OK
  rules        6.6 KB / max 16.0 KB      87 lines / max 250 lines  OK
  skills       22.2 KB / max 32.0 KB     136 lines / max 400 lines OK
Some prompt size budgets were exceeded.
\`\`\`

4. Prompt ownership rule in `agent/AGENTS.md`:
   - Line 43: `- **PROMPT-OWNERSHIP**: Prompt surfaces belong to the human. Edits to system prompts, agent instructions, or prompt templates by an agent are allowed ONLY after explicit user approval.`

---

### R03: Usage Audit CLI
1. Execution of `node tools/usage-audit.mjs --days 30 --top 10` on real sessions:
   - Exit code: `0`
   - Raw table:
\`\`\`text
=== Аудит использования инструментов и скиллов (30 дн.) ===

Сессий просканировано: 199 (всего файлов: 199)
Строк событий обработано: 94361 (битых: 0)

--- Инструменты (Топ-10) ---
  1. read                            10936 вызовов  [встроенный]
  2. bash                             8074 вызовов  [встроенный]
  3. grep                             2671 вызовов  [встроенный]
  4. glob                              713 вызовов  [встроенный]
  5. todo                              216 вызовов  [встроенный]
  6. mcp__crawl4ai_md                   17 вызовов  [mcp]
  7. mcp__hindsight_retain              10 вызовов  [mcp]
  8. mcp__codebase_index_index_status   10 вызовов  [mcp]
  9. mcp__hindsight_recall               9 вызовов  [mcp]
 10. mcp__serena_execute_shell_command   7 вызовов  [mcp]

--- Скиллы (Топ-10) ---
  1. diagnosing-bugs                    11 обращений
  2. requesting-code-review              7 обращений
  3. domain-modeling                     6 обращений
  4. quality-engineer                    4 обращений
  5. test-first-bugs                     3 обращений
  6. animate                             1 обращений
  7. rewind                              1 обращений
  8. web-search                          1 обращений
  9. find-skills                         1 обращений
\`\`\`

2. Execution of `node tools/usage-audit.mjs --days 30 --top 10 --json`:
   - Exit code: `0`
   - Excerpt from JSON: `"totalFiles": 199, "scannedFiles": 199, "totalLines": 94361, "malformedLines": 0, "days": 30`. Output contains only tool/skill IDs and counts, with no message texts.

3. Empty sessions directory check:
   - Command: `node tools/usage-audit.mjs --sessions D:/TMP/oracle_empty_sessions`
   - Exit code: `0`
   - Raw output:
\`\`\`text
Сессий не найдено
- В каталоге сессий нет .jsonl файлов
\`\`\`

---

### R04: Domain Context Decisions
1. Fixture with `docs/adr/001-billing.md` and `openspec/changes/ch1/proposal.md`:
   - Command: `node tools/domain-context.mjs --domain billing --root D:/TMP/oracle_r04_repo --no-gh`
   - Exit code: `0`
   - Raw output snippet:
\`\`\`text
=== DECISIONS ===
- docs/adr/001-billing.md: We chose Stripe for billing payments.
- openspec/changes/ch1/proposal.md: Enhance billing subscription flows.
\`\`\`

2. Unmatched domain search:
   - Command: `node tools/domain-context.mjs --domain nonexistenttoken --root D:/TMP/oracle_r04_repo --no-gh`
   - Exit code: `0`
   - Raw output snippet:
\`\`\`text
=== DECISIONS ===
решений по домену не найдено
\`\`\`

---

### R05: Context Checklist & Memory Hygiene
1. `agent/agents/orchestrator.md`:
   - Line 80: `Wave 1 (Context Pack, mandatory before Wave 2):`
   - Line 81: `- MUST assemble a CONTEXT PACK from >= 5 distinct sources before writing any spec or code. Check all that apply: (1) docs/adr/*.md, (2) openspec/changes/*/proposal.md, (3) git log -S <domain-term> -n 5, (4) CONTEXT.md ubiquitous language, (5) tools/domain-context.mjs --domain <domain>, (6) repo structure / codemap. If < 5 sources exist in the repo, state which were checked and missing.`
   - Line 81: `- Noise rule: more context is NOT better context. Filter for decision-bearing facts. Exclude generated files, lockfiles, minified assets, and test fixtures from the context pack.`

2. `agent/AGENTS.md`:
   - Line 33: `- **DURABLE-FIRST**: Durable knowledge goes to repo files (`docs/adr/`, `CONTEXT.md`), NOT agent memory. Agent memory is for ephemeral session state only. When an architectural decision is made, record it in `docs/adr/NNN-<slug>.md` immediately.`

---

### R06: Install Doctor CLI & Gate
1. Running doctor with full harness parameters:
   - Command: `node tools/doctor.mjs --harness D:/ohmypi --agent-dir C:/Users/Administrator/.omp/agent --agents-home C:/Users/Administrator/.agents --json`
   - Exit code: `0`
   - Summary: `{"total": 7, "pass": 7, "warn": 0, "fail": 0}`, overall `PASS`.

2. Running doctor in repo mode:
   - Command: `node tools/doctor.mjs --harness D:/ohmypi/workflow-repo --json`
   - Exit code: `0`
   - Summary: `{"total": 6, "pass": 6, "warn": 0, "fail": 0}`, overall `PASS`.

3. Broken harness detection:
   - Fixture at `D:/TMP/oracle_broken_harness` missing `agent/AGENTS.md`.
   - Command: `node tools/doctor.mjs --harness D:/TMP/oracle_broken_harness`
   - Exit code: `1`
   - Raw output snippet: `[FAIL] Agent definitions: mandatory agent/AGENTS.md missing` and `Doctor found 1 failure(s).`

4. Verification of gate in `install.ps1`:
   - Line 374: `if (Test-Path "$HarnessRoot\tools\doctor.mjs") {`
   - Line 375: `  $doctorOut = & node "$HarnessRoot\tools\doctor.mjs" --harness "$HarnessRoot" --agent-dir "$agentDir" --agents-home "$agentsHome" 2>&1`
   - Line 376: `  $doctorExit = $LASTEXITCODE`
   - Line 377: `  if ($doctorExit -ne 0) {`
   - Line 384: `    exit 1`
   - Line 385: `  }`
   - Line 386: `  Ok "install doctor checks passed"`

---

### R07: Documentation & CONTEXT.md
1. Section headers in `README.md`:
   - Line 29: `### Wave 3.5: Stage B (Упрощение)`
   - Line 41: `### Контроль бюджета промптов (Prompt Budget)`
   - Line 49: `### Аудит использования инструментов (Usage Audit)`
   - Line 57: `### Диагностика окружения (Install Doctor)`

2. Glossary terms in `CONTEXT.md`:
   - Line 121: `| **Stage B** | Фаза волнового пайплайна (Wave 3.5) ... |`
   - Line 122: `| **Бюджет промптов (Prompt Budget)** | Ограничение на суммарный размер промптов ... |`
   - Line 123: `| **Usage-Audit** | Инструмент аналитики вызовов инструментов и скиллов ... |`
   - Line 124: `| **Doctor** | Инструмент самодиагностики установленного харнесса ... |`

---

### R08: Full Regression Suite Verification
1. Node test suites:
   - Command: `node --test tools/tests/doctor.test.mjs tools/tests/usage-audit.test.mjs tools/tests/domain-context.test.mjs tools/tests/benchmark.test.mjs tools/tests/auto-review.test.mjs tools/tests/debt-ledger.test.mjs tools/tests/oracle-model.test.mjs tools/tests/context-inbox.test.mjs tools/tests/return-contract.test.mjs tools/tests/cache-doctor.test.mjs tools/tests/workflow-metrics.test.mjs tools/tests/workflow-suggest.test.mjs tools/tests/prompt-cache.test.mjs`
   - Exit code: `0`
   - Raw output:
```text
ℹ tests 100
ℹ suites 2
ℹ pass 100
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32627.4747
```
   - Summary: `pass 100, fail 0` (100/100 tests passed).

2. Python session cost test:
   - Command: `D:/Python312/python.exe tools/tests/test_session_cost.py`
   - Exit code: `0`
   - Summary: `Ran 8 tests in 0.031s ... OK` (8/8 tests passed).

3. Harness audit PowerShell script:
   - Command: `powershell -File tools/audit.ps1`
   - Exit code: `0`
   - Summary: `all 14 checks clean` (14/14 PASS).

4. Workflow harness full verification PowerShell script:
   - Command: `powershell -File verify.ps1`
   - Exit code: `0`
   - Summary: `27/27 checks passed`.

---

## Verdict: ACCEPT

Every requirement R01 through R08 is thoroughly proven with direct script executions and verbatim file quotes. No regressions observed.
