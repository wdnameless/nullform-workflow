# Acceptance Oracle Verdict: Archmap Removal

## Verdict: ACCEPT

### R01 (модули удалены)
1. `ls tools/ | grep -i archmap`
```text
Exit code: 1 (пусто)
```
2. `ls -d tools/report`
```text
ls: cannot access 'tools/report': No such file or directory
Exit code: 2
```
3. `ls tools/package*.json`
```text
ls: cannot access 'tools/package*.json': No such file or directory
Exit code: 2
```
4. `node tools/archmap.mjs`
```text
node:internal/modules/cjs/loader:1503
  throw err;
  ^

Error: Cannot find module 'D:\ohmypi\workflow-repo\tools\archmap.mjs'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1500:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1071:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1095:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1116:12)
    at Module._load (node:internal/modules/cjs/loader:1285:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  code: 'MODULE_NOT_FOUND',
  requireStack: []
}

Node.js v24.17.0
Exit code: 1
```
5. `ls -d skills/architecture-observability`
```text
ls: cannot access 'skills/architecture-observability': No such file or directory
Exit code: 2
```
6. `ls -d C:/Users/Administrator/.agents/skills/architecture-observability`
```text
ls: cannot access 'C:/Users/Administrator/.agents/skills/architecture-observability': No such file or directory
Exit code: 2
```
7. `ls -d .archmap`
```text
ls: cannot access '.archmap': No such file or directory
Exit code: 2
```
8. `git status --short | grep '^D '`
```text
D  skills/architecture-observability/SKILL.md
D  tools/archmap-analysis.mjs
D  tools/archmap-cache.mjs
D  tools/archmap-demo.mjs
D  tools/archmap-problems.mjs
D  tools/archmap-report.mjs
D  tools/archmap.mjs
D  tools/package-lock.json
D  tools/package.json
D  tools/report/client.core.js
D  tools/report/client.graphs.js
D  tools/report/client.problems.js
D  tools/report/page.css
D  tools/tests/archmap-analysis.test.mjs
D  tools/tests/archmap-problems.test.mjs
D  tools/tests/archmap-report.test.mjs
Exit code: 0
```

---

### R02 (промпты чисты)
1. `grep -rin archmap agent/ README.md CONTEXT.md`
```text
Exit code: 1 (пусто)
```
2. `node tools/prompt-lint.mjs scan --root .`
```text
prompt-lint: no volatile literals in 81 prompt surfaces.
Exit code: 0
```

---

### R03 (auto-review без archmap, с гейтом)
1. `grep -c archmap tools/auto-review.mjs`
```text
0
Exit code: 1
```
2. `node tools/auto-review.mjs --root <tmpA>` (пустой каталог)
```text
=== СЕКЦИЯ 1: Базовая валидация ===
...
=== СЕКЦИЯ 4: Проверка долгов и триггеров (debt-ledger) ===
...
✅ ИТОГ: АВТО-РЕВЬЮ ПРОЙДЕНО УСПЕШНО (Код 0)
Exit code: 0
```
3. `node tools/auto-review.mjs --root <tmpB>` (с `// defer: later` без `upgrade:`)
```text
=== СЕКЦИЯ 4: Проверка долгов и триггеров (debt-ledger) ===
[!] Обнаружены маркеры отложенных задач без триггеров или с истекшим сроком:
[FAIL] sub/x.js:1: // defer: later (отсутствует триггер)
--------------------------------------------------------------------------------
❌ ИТОГ: АВТО-РЕВЬЮ НЕ ПРОЙДЕНО (Код 1)
Exit code: 1
```

---

### R04 (обвязка/CI)
1. `grep -c archmap tools/sync.ps1 tools/audit.ps1 verify.ps1 install.ps1 .github/workflows/repo-gate.yml templates/ci/workflow-gate.yml`
```text
tools/sync.ps1:0
tools/audit.ps1:0
verify.ps1:0
install.ps1:0
.github/workflows/repo-gate.yml:0
templates/ci/workflow-gate.yml:0
Exit code: 1
```
2. `grep -n archmap tests/test-portability.ps1`
```text
81:    Assert (-not (Test-Path (Join-Path $installedHarness "tools\archmap.mjs"))) "tools/archmap.mjs must not exist"
Exit code: 0
```
3. `powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1`
```text
auto-review CLI runs and respects problem gate                  PASS   clean=0 gate=1
debt ledger gate works                                          PASS   noTrigger=1 ok=0 json=ok
CI template present and parses as YAML                          PASS   valid CI YAML template
26/26 checks passed
Exit code: 0
```
4. `powershell -NoProfile -ExecutionPolicy Bypass -File tests/test-portability.ps1`
```text
  Repo docs: README.md    Core spec: $HarnessRoot\core\PORTABLE.md    Full law: $HarnessRoot\agent\AGENTS.md


All 11 portability regression tests PASSED successfully!
Exit code: 0
```

---

### R05 (доки)
1. `grep -rin "Карта архитектуры" README.md`
```text
Exit code: 1 (пусто)
```
2. `grep -n archmap .gitignore`
```text
Exit code: 1 (пусто)
```

---

### R06 (без регрессий)
1. `node --test tools/tests/*.test.mjs`
```text
ℹ tests 73
ℹ suites 2
ℹ pass 73
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 731.2457
Exit code: 0
```
2. `D:/Python312/python.exe tools/tests/test_session_cost.py`
```text
........
----------------------------------------------------------------------
Ran 8 tests in 0.012s

OK
Exit code: 0
```
3. `powershell -NoProfile -ExecutionPolicy Bypass -File tools/audit.ps1`
```text
debt ledger tool              PASS   debt-ledger.mjs present                          0
portable core specification   PASS   core\PORTABLE.md present                         0
codemap currency              PASS   not initialised (optional)                       3
oracle model role             PASS   oracle=nullform-gateway/gemini-3.8-flash-high 7190all 10 checks clean
Exit code: 0
```
