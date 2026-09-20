# Acceptance Verdict: lean-engineering

Verdict: **ACCEPT**

## Gates
- gate_lint: PASS
- gate_tests: PASS
- gate_debt_ledger: PASS
- gate_archmap: PASS
- gate_docs: PASS
- gate_ci_sync: PASS

## Criteria Evidence (R01 - R07)

### R01 (Solution ladder in roles)
- Status: **PROVEN**
- Verification commands & exact lines:
  - `agent/agents/fixer.md` lines 29–49:
    - Line 29: `<ladder>`
    - Line 30: `Solution ladder (evaluate after understanding the task, never instead):`
    - Line 31: `1. Do we need this at all? (Can requirement be dropped or solved by removing dead code?)`
    - Line 32: `2. Reuse: Call existing functions, helpers, or utilities in the codebase.`
    - Line 33: `3. Standard library: Use built-in language/runtime primitives.`
    - Line 34: `4. Native platform feature: Use platform/runtime features before adding libraries.`
    - Line 35: `5. Already installed dependency: Use what is already installed in dependencies; no new packages.`
    - Line 36: `6. One line: Express the logic in a single readable line or standard idiom.`
    - Line 37: `7. Minimum: The smallest correct code that passes tests and handles real cases.`
    - Line 38: `When two rungs work, ALWAYS choose the higher rung.`
    - Line 40: `NEVER-CUT list (never sacrifice for simplicity):`
    - Line 41: `- Validation on trust boundaries`
    - Line 42: `- Error handling where data loss is possible`
    - Line 43: `- Security checks and invariants`
    - Line 44: `- Accessibility requirements`
    - Line 45: `- Explicitly requested requirements`
    - Line 47: `Bug-report is a symptom: grep all callsites before editing implementation.`
    - Line 48: `Deliberate simplification ceiling: record \`defer: <what> | ceiling: <limit> | upgrade: <trigger>\` (audited by \`tools/debt-ledger.mjs\`).`
    - Line 49: `</ladder>`
  - `agent/agents/designer.md` line 50:
    - Line 50: `1. Read existing components, tokens, patterns; reuse before inventing. Apply solution ladder: prefer native platform features (\`<input type="date">\`, \`<dialog>\`, CSS over JS), use installed dependencies before adding new packages, prefer a single line or minimal working solution. NEVER cut accessibility or interactive states. Deliberate simplification ceiling: record \`defer: <what> | ceiling: <limit> | upgrade: <trigger>\`.`

### R02 (Tagged review lenses)
- Status: **PROVEN**
- Verification commands & exact lines in `agent/agents/reviewer.md`:
  - Line 91: `- **Simplest solution (Ponytail / Lean lens)**:`
  - Line 92: `  Flag over-engineering, dead code, and redundant indirection using tagged prefixes:`
  - Line 93: `  - \`delete:\` dead code or unused flexibility (suggested replacement: "nothing")`
  - Line 94: `  - \`stdlib:\` replace bespoke helper with standard library (MUST name stdlib function)`
  - Line 95: `  - \`native:\` replace library/wrapper with platform feature (MUST name native feature)`
  - Line 96: `  - \`yagni:\` abstraction with single implementation or unused config option (suggest replacement)`
  - Line 97: `  - \`shrink:\` same logic shorter, without losing clarity or safety (MUST show shorter form)`
  - Line 98: `  Every finding MUST name the replacement (or "nothing").`
  - Line 99: `  Conclude the explanation with \`net: -N lines possible\` or \`Lean already.\`.`
  - Line 100: `  Minimal smoke/self-check test is the floor — NEVER flag as bloat.`

### R03 (Defer marker & Debt Ledger tool)
- Status: **PROVEN**
- Fixture created outside repository: `D:\TMP\ora2-uyah3s` containing:
  - `with-upgrade.js`: `// defer: cache lookup | ceiling: 100 items | upgrade: hit rate drops`
  - `no-upgrade.py`: `# defer: simple list | ceiling: 50 items`
  - `doc.md`: `// defer: markdown note | ceiling: none`
  - `prose.txt`: `defer: plain text without comment prefix | ceiling: 10`
- Executed commands & raw output:
  - `node tools/debt-ledger.mjs scan --root D:/TMP/ora2-uyah3s`:
    Raw output:
```
## no-upgrade.py
  no-upgrade.py:1 — simple list | ceiling: 50 items | [no-trigger]
## with-upgrade.js
  with-upgrade.js:1 — cache lookup | ceiling: 100 items | upgrade: hit rate drops
2 маркеров, 1 без триггера.
```
    (Exit code: 0. Ignored `doc.md` and `prose.txt`).
  - `node tools/debt-ledger.mjs check --root D:/TMP/ora2-uyah3s`:
    Exit code: 1 (detected `no-upgrade.py` with missing trigger).
  - `node tools/debt-ledger.mjs check --root <fixture-with-all-upgrades>`:
    Exit code: 0 (`1 маркеров, 0 без триггера.`).
  - `node tools/debt-ledger.mjs scan --root D:/TMP/ora2-uyah3s --json`:
    Raw output:
```json
{
  "root": "D:/TMP/ora2-uyah3s",
  "total": 2,
  "noTrigger": 1,
  "byFile": {
    "no-upgrade.py": [
      {
        "line": 1,
        "what": "simple list",
        "ceiling": "50 items",
        "noTrigger": true
      }
    ],
    "with-upgrade.js": [
      {
        "line": 1,
        "what": "cache lookup",
        "ceiling": "100 items",
        "upgrade": "hit rate drops",
        "noTrigger": false
      }
    ]
  }
}
```
  - `node tools/debt-ledger.mjs scan --root D:/TMP/ora2-uyah3s --write D:/TMP/ora2-uyah3s/LEDGER1.md` followed by `--write D:/TMP/ora2-uyah3s/LEDGER2.md`:
    Byte-identical check: `fc.exe /b LEDGER1.md LEDGER2.md` -> `FC: no differences encountered`. Both files 340 bytes.
  - Custom marker `--marker custom`:
    Raw output on `c.js` with `// custom: test | ceiling: 5 | upgrade: soon`:
    `## c.js \n c.js:1 — test | ceiling: 5 | upgrade: soon \n 1 маркеров, 0 без триггера.` (Exit code: 0).
  - Missing/non-existent root: `node tools/debt-ledger.mjs scan --root D:/TMP/nonexistent-path-9999`:
    Exit code: 2.
    Raw stderr output: `каталог не найден: D:\TMP\nonexistent-path-9999`

### R04 (Archmap integration & problems)
- Status: **PROVEN**
- Executed commands & raw output:
  - `node tools/archmap.mjs scan --root D:/TMP/ora2-uyah3s`:
    `archmap: 2 files · 2 lines · MI 98/100 ... problems: 0 critical, 0 high, 0 medium, 1 low (1 total)` (Exit code 0).
  - `node tools/archmap.mjs json --root D:/TMP/ora2-uyah3s`:
    Extract from raw JSON output:
```json
"problems": [
  {
    "id": "debt-no-trigger-no-upgrade.py-1",
    "file": "no-upgrade.py",
    "line": 1,
    "rule": "debt-no-trigger",
    "category": "maintainability",
    "severity": "low",
    "title": "Маркер defer без условия upgrade",
    "description": "Маркер технического долга на строке 1 не содержит условия снятия (upgrade:). Без триггера долг рискует остаться навсегда.",
    "snippet": "# defer: simple list | ceiling: 50 items",
    "suggestion": "Добавьте условие апгрейда: // defer: <что> | ceiling: <порог> | upgrade: <когда переписать>",
    "aiPrompt": "В файле no-upgrade.py на строке 1 маркер defer не имеет условия upgrade. Добавь условие апгрейда: upgrade: <условие>."
  }
]
```
    Rule `debt-no-trigger` reported ONLY for `no-upgrade.py` (0 problems for `with-upgrade.js`).
  - `node --test tools/tests/archmap-problems.test.mjs`:
    Raw output:
```
✔ archmap-problems: redactSecrets masks secret patterns with [REDACTED] (1.1982ms)
✔ archmap-problems: generates all 5 categories (structure, optimization, security, reliability, maintainability) (22.128ms)
✔ archmap-cache: saveCache and loadCache persist entries and version (3.1505ms)
✔ archmap-problems: detects debt-no-trigger only for defer markers without upgrade (2.4231ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 123.0993
```
    (Exit code: 0).

### R05 (Context and documentation)
- Status: **PROVEN**
- Verification commands & exact raw output:

Command 1: `grep -n "^## \|^### " README.md | tail -8`
```
190:### Бюджеты вызовов инструментов
208:### Защищенный автономный режим (`guarded auto`)
224:## Кеш нейросетей: качество прежде экономии
245:## Бережливая разработка (Lean engineering)
249:### Лестница решений (Solution ladder)
263:### Маркер отложенных упрощений (Defer marker)
276:### Тегированное ревью (Review lens)
287:### Утилита debt-ledger
```

Command 2: `sed -n '44,60p' CONTEXT.md`
```
44:- **Interfaces contract** — `interfaces.md`. Module boundaries, public
45:  signatures, and ownership zones, seeded before any build spawn.
46:- **Gate** — a mandatory checkpoint (G1–G4). A failed gate sends the phase back.
47:- **Blind acceptance** — Wave 4. The oracle judges the product against the
48:  manifest and the running artifact, never against our own spec.
49:- **Oracle** — the read-only acceptance role. See *Roles*.
50:- **Review budget** — at most one initial review plus two re-reviews per gate
51:  (defined by `skill://deepwork`).
52:
53:## Lean engineering
54:
55:- **Solution ladder** — the ordered preference for resolving implementation needs (reuse > stdlib > platform > installed dep > one-line > minimum) evaluated after understanding the task. Never applied at the expense of security, validation at boundaries, error handling with data loss risk, or accessibility.
56:- **Defer marker** — a single-line code comment documenting an intentional simplification ceiling: `defer: <what> | ceiling: <limit> | upgrade: <trigger>`. Recognized only when `defer:` starts the comment body immediately after the comment prefix (`//`, `#`, `--`, `;`, `/*`, `*`, `<!--`) and optional whitespace. Enables deliberate debt with an explicit boundary and upgrade trigger.
57:- **Debt ledger** — the registry and audit report of all active defer markers, generated and verified by `tools/debt-ledger.mjs`.
58:
59:## Roles
60:
```

README.md lines 271-274 (grammar & comment prefix rule):
```
271:Грамматика маркера:
272:`defer: <что упрощено> | ceiling: <потолок> | upgrade: <триггер пересмотра>`
273:Отсутствие поля `upgrade:` трактуется как no-trigger (замечание при аудите).
274:Маркер распознаётся только в начале содержимого комментария (сразу после префикса `//`, `#`, `--`, `;`, `/*`, `*`, `<!--` и опциональных пробелов); упоминания `defer:` в середине строк маркерами не считаются.
```

### R06 (Plumbing & CI gate)
- Status: **PROVEN**
- Verification of plumbing hooks:
  - `tools/sync.ps1` line 90:
    `  'tools\\debt-ledger.mjs',`
  - `tests/test-portability.ps1` line 93:
    `    Assert (Test-Path (Join-Path $installedHarness "tools\\debt-ledger.mjs")) "debt-ledger tool must install"`
  - `tools/audit.ps1` lines 180–182:
    `  $dl = Join-Path $HarnessRoot 'tools\\debt-ledger.mjs'`
    `  if (-not (Test-Path $dl)) { return @{ Ok = $false; Detail = 'debt-ledger.mjs missing' } }`
    `  @{ Ok = $true; Detail = 'debt-ledger.mjs present' }`
  - `verify.ps1` lines 421–422:
    `  $tool = Join-Path $HarnessRoot 'tools\\debt-ledger.mjs'`
    `  if (-not (Test-Path $tool)) { throw "tools/debt-ledger.mjs not found" }`
  - `.github/workflows/repo-gate.yml` line 46:
    `            node --test "tools/tests/*.test.mjs"`
- Prompt lint commands:
  - `node tools/prompt-lint.mjs scan --root .` -> exit code: 0, output: `prompt-lint: no volatile literals in 82 prompt surfaces.`
  - `node tools/prompt-lint.mjs check --root .` -> exit code: 0, output: `prompt-lint: 82 prompt surfaces match the baseline.`

### R07 (No regressions & Test Suite Execution)
- Status: **PROVEN**
- `node --test` command executed with exact test files list from `tools/tests/`:
  - Test files (13 files total):
    1. `tools/tests/archmap-analysis.test.mjs`
    2. `tools/tests/archmap-problems.test.mjs`
    3. `tools/tests/archmap-report.test.mjs`
    4. `tools/tests/auto-review.test.mjs`
    5. `tools/tests/cache-doctor.test.mjs`
    6. `tools/tests/context-inbox.test.mjs`
    7. `tools/tests/debt-ledger.test.mjs`
    8. `tools/tests/domain-context.test.mjs`
    9. `tools/tests/oracle-model.test.mjs`
    10. `tools/tests/prompt-cache.test.mjs`
    11. `tools/tests/return-contract.test.mjs`
    12. `tools/tests/workflow-metrics.test.mjs`
    13. `tools/tests/workflow-suggest.test.mjs`
  - Raw summary lines:
```
ℹ tests 90
ℹ suites 2
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3144.6913
```
    (Exit code: 0).
  - Python test command: `D:/Python312/python.exe tools/tests/test_session_cost.py`:
    Raw summary lines:
```
........
----------------------------------------------------------------------
Ran 8 tests in 0.020s

OK
```
    (Exit code: 0).
