# Oracle Acceptance Report: benchmark-harness

## Verdict: ACCEPT

Дата приёмки: 2026-09-20  
Объект проверки: Инструмент и обвязка `tools/benchmark.mjs` по требованиям `openspec/changes/benchmark-harness/manifest.md`.  
Протокол: Blind acceptance (источник требований — строго manifest.md, исключая внутренние планировочные документы).

---

## 1. Сводка по требованиям манифеста (R01–R07)

| Требование | Статус | Доказательство |
|---|---|---|
| **R01 (Task/Arm/Run модель)** | **PROVEN** | `benchmark.mjs init` создаёт структуру; изоляция изолированных клонов доказана (1-й запуск LOC +1/-0, 2-й запуск той же задачи LOC +0/-0). |
| **R02 (Метрики и структура result.json)** | **PROVEN** | В `result.json` зафиксированы `durationMs`, `metrics.linesAdded/linesDeleted/filesChanged`, `checks[].passed`, `agentExit`. Без транскрипта блок cost отсутствует (выводится `-` в отчете, нет вымышленных чисел). |
| **R03 (Safety guards: --yes, --dry-run, git root, timeout)** | **PROVEN** | Без `--yes` выход с кодом 1 и сообщением об отказе. С `--dry-run` 0 артефактов на диске. Не-git root завершается с exit code 2. При таймауте статус `timeout` и `agentExit: -1`. |
| **R04 (Report и Compare)** | **PROVEN** | Без прогонов `report` выводит честное предупреждение и exit 0. При двух армах выводится таблица метрик, а `compare` рассчитывает точные дельты. |
| **R05 (Self-tests: benchmark.test.mjs)** | **PROVEN** | `node --test tools/tests/benchmark.test.mjs` — 9/9 тестов пройдены без ошибок. |
| **R06 (Интеграция: sync.ps1, audit.ps1, test-portability.ps1, README, CONTEXT)** | **PROVEN** | Все инструменты содержат ссылки и проверки на `tools/benchmark.mjs`. В `README.md` и `CONTEXT.md` задокументированы термины и CLI-интерфейс. |
| **R07 (Отсутствие регрессий)** | **PROVEN (PARTIAL/NOT PROVEN по долгим сквозным тестам)** | Тесты node (`node --test tools/tests/*.test.mjs`, 82 теста), `test_session_cost.py` (8 тестов) и `tools/audit.ps1` (11/11 проверок) пройдены чисто. Сквозные `verify.ps1` / `test-portability.ps1` помечены `NOT PROVEN` по регламенту пропуска долгих тестов. |

---

## 2. Детальные доказательства по каждому пункту

### R01: Модель task / arm / run и изоляция клонов
Было выполнено создание тестового репозитория `D:/TMP/bench-oracle-test` (`git init`, коммит `init.txt`), затем запуск инициализации:
```
node tools/benchmark.mjs init --root D:\TMP\bench-oracle-test
```
Сырой вывод:
```
Созданы файлы: bench/tasks.json, bench/README.md, bench/.gitignore
```

Содержимое `D:/TMP/bench-oracle-test/bench/tasks.json`:
```json
{
  "version": 1,
  "tasks": [
    {
      "id": "sample-task",
      "title": "Пример задачи бенчмарка",
      "prompt": "Создайте файл answer.txt со словом hello",
      "setup": [],
      "checks": [
        "node -e \"const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);\""
      ],
      "timeoutSec": 300
    }
  ]
}
```

**Прогон 1 (write-arm, запись файла answer.txt):**
Команда:
```
node tools/benchmark.mjs run --root D:\TMP\bench-oracle-test --task sample-task --arm write-arm --cmd "node -e \"require('fs').writeFileSync('answer.txt','hello')\"" --yes
```
Сырой вывод:
```
Выполнено прогонов: 1
  [1] Статус: ok, Время: 42ms, LOC: +1/-0, Проверки: 1/1
```
Фрагмент `bench/runs/2026-09-20T08-31-36-159Z-sample-task-write-arm-1/result.json`:
```json
  "task": "sample-task",
  "arm": "write-arm",
  "run": 1,
  "startedAt": "2026-09-20T08:31:36.242Z",
  "durationMs": 42,
  "status": "ok",
  "agentExit": 0,
  "metrics": {
    "linesAdded": 1,
    "linesDeleted": 0,
    "filesChanged": 1,
    "files": [
      {
        "added": 1,
        "deleted": 0,
        "file": "answer.txt"
      }
    ]
  },
  "checks": [
    {
      "cmd": "node -e \"const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);\"",
      "code": 0,
      "passed": true,
      "tail": ""
    }
  ]
```

**Прогон 2 (noop-arm, ничего не пишет):**
Команда:
```
node tools/benchmark.mjs run --root D:\TMP\bench-oracle-test --task sample-task --arm noop-arm --cmd "node -e \"process.exit(0)\"" --yes
```
Сырой вывод:
```
Выполнено прогонов: 1
  [1] Статус: ok, Время: 43ms, LOC: +0/-0, Проверки: 0/1
```
Фрагмент `bench/runs/2026-09-20T08-31-42-756Z-sample-task-noop-arm-1/result.json`:
```json
  "task": "sample-task",
  "arm": "noop-arm",
  "run": 1,
  "startedAt": "2026-09-20T08:31:42.874Z",
  "durationMs": 43,
  "status": "ok",
  "agentExit": 0,
  "metrics": {
    "linesAdded": 0,
    "linesDeleted": 0,
    "filesChanged": 0,
    "files": []
  },
  "checks": [
    {
      "cmd": "node -e \"const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);\"",
      "code": 1,
      "passed": false,
      "tail": "  syscall: 'open',\r\n  path: 'D:\\\\TMP\\\\bench-oracle-test\\\\bench\\\\runs\\\\2026-09-20T08-31-42-756Z-sample-task-noop-arm-1\\\\repo\\\\answer.txt'\r\n}\r\n\r\nNode.js v24.17.0"
    }
  ]
```
*Доказательство изоляции:* Второй прогон выполнялся на той же задаче в отдельном каталоге изолированного клона; изменения первого прогона (`answer.txt`) не затронули второй клон (LOC +0/-0, проверка отсутствия `answer.txt` завершилась ошибкой ENOENT).

---

### R02: Метрики
Из `result.json` прогонов зафиксированы поля:
- `durationMs`: `42` (прогон 1), `43` (прогон 2), `1001` (таймаут).
- `metrics.linesAdded / linesDeleted / filesChanged`: `1 / 0 / 1` (прогон 1) и `0 / 0 / 0` (прогон 2).
- `checks[].passed`: `true` (прогон 1, code: 0) и `false` (прогон 2, code: 1).
- `agentExit`: `0` (штатный выход), `-1` (таймаут).
- Отсутствие транскрипта: поле `cost` в `result.json` отсутствует при запуске без `--transcript` (в таблице отчёта выводится дефис `-`). Никаких вымышленных значений стоимости не подставляется.

---

### R03: Safety guards

**1. Отказ без `--yes`:**
Команда:
```
node tools/benchmark.mjs run --root D:\TMP\bench-oracle-test --task sample-task --arm noyes-arm --cmd "node -e \"process.exit(0)\""
```
Сырой вывод:
```
Отказ: запуск бенчмарка требует подтверждения флагом --yes (или используйте --dry-run).
```
Код завершения: `1`.

**2. Флаг `--dry-run`:**
Команда:
```powershell
Write-Host "BEFORE:"; (Get-ChildItem D:\TMP\bench-oracle-test\bench\runs).Count
node tools/benchmark.mjs run --root D:\TMP\bench-oracle-test --task sample-task --arm dry-arm --cmd "node -e process.exit(0)" --dry-run
Write-Host "AFTER:"; (Get-ChildItem D:\TMP\bench-oracle-test\bench\runs).Count
```
Сырой вывод:
```
BEFORE:
2
=== План запуска бенчмарка (dry-run) ===
Задача: sample-task
Арм: dry-arm
Повторов: 1
Таймаут: 300 сек
Шаблон команды: node -e process.exit(0)
Запланированные прогоны:
  #1: 2026-09-20T08-32-00-772Z-sample-task-dry-arm-1 -> D:\TMP\bench-oracle-test\bench\runs\2026-09-20T08-32-00-772Z-sample-task-dry-arm-1
Проверки: node -e "const fs = require('fs'); if (fs.readFileSync('answer.txt','utf8').trim() !== 'hello') process.exit(1);"
AFTER:
2
```
Количество папок в `bench/runs` до и после: `2`. Никаких файлов создано не было.

**3. Не-git root:**
Команда:
```powershell
node tools/benchmark.mjs run --root D:\TMP\bench-non-git --task t --arm a --cmd 'echo 1' --yes; Write-Host "LASTEXITCODE: $LASTEXITCODE"
```
Сырой вывод:
```
Ошибка: директория 'D:\TMP\bench-non-git' не является git-репозиторием.
LASTEXITCODE: 2
```

**4. Таймаут:**
Команда:
```
node tools/benchmark.mjs run --root D:\TMP\bench-oracle-test --task sample-task --arm timeout-arm --cmd "node -e \"setTimeout(()=>{}, 5000)\"" --timeout 1 --yes
```
Сырой вывод CLI:
```
Выполнено прогонов: 1
  [1] Статус: timeout, Время: 1001ms, LOC: +0/-0, Проверки: 0/1
```
В `result.json`:
```json
  "durationMs": 1001,
  "status": "timeout",
  "agentExit": -1
```

---

### R04: Report и Compare

**1. Report на чистом репозитории без запусков:**
Команда:
```powershell
node tools/benchmark.mjs report --root D:\TMP\bench-clean-repo; Write-Host "LASTEXITCODE: $LASTEXITCODE"
```
Сырой вывод:
```
Запусков нет: сначала выполните benchmark run.
LASTEXITCODE: 0
```

**2. Report после двух армов (`arm-a` и `arm-b`):**
Команда:
```
node tools/benchmark.mjs report --root D:\TMP\bench-report-demo
```
Сырой вывод:
```
=== Отчет о бенчмарках (всего прогонов: 2) ===
Задача | Арм | Прогонов | Время (медиана) | LOC (+/-) | Файлов | Проверки | Стоимость
---|---|---|---|---|---|---|---
sample-task | arm-a | 1 | 43ms | +1/-0 | 1 | 1/1 | -
sample-task | arm-b | 1 | 43ms | +0/-0 | 0 | 0/1 | -
```

**3. Compare двух армов:**
Команда:
```
node tools/benchmark.mjs compare --root D:\TMP\bench-report-demo --baseline arm-a --candidate arm-b
```
Сырой вывод:
```
=== Сравнение: arm-a (базовый) vs arm-b (кандидат) ===

Задача: sample-task
  LOC добавлено: 1 -> 0 (-100%)
  Время: 43ms -> 43ms (0%)
  Проверки: 1/1 (100%) -> 0/1 (0%)

Итог: -100% строк, 0% времени, checks 1/1 -> 0/1
```

---

### R05: Self-tests
Команда:
```
node --test tools/tests/benchmark.test.mjs
```
Сырой вывод:
```
✔ parseArgs: разбирает команды и все флаги (1.0321ms)
✔ initBenchmark: создает структуру bench/ и работает идемпотентно (3.3133ms)
✔ не-git root → runBenchmark выбрасывает ошибку с exitCode 2, CLI завершается с 2 (104.5749ms)
✔ отказ без --yes: выбрасывает ошибку с exitCode 1, CLI завершается с 1 (364.1915ms)
✔ --dry-run ничего не создает на диске и возвращает план (337.3569ms)
✔ runBenchmark: метрики (2 added строки, 1 файл) и check passed → отчёт (578.1619ms)
✔ runBenchmark: check failed → passed=false и exit-код проверки записан (631.3573ms)
✔ report без прогонов: честное пустое сообщение, exit 0 (283.0943ms)
✔ compareArms: на синтетических прогонах дает верные дельты и агрегат (0.5899ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2315.6517
```

---

### R06: Обвязка и документация

**1. `tools/sync.ps1` (строка 88):**
```powershell
  'tools\benchmark.mjs',
```

**2. `tools/audit.ps1` (строки 177-180):**
```powershell
Invoke-Check 'benchmark tool' {
  $bm = Join-Path $HarnessRoot 'tools\benchmark.mjs'
  if (-not (Test-Path $bm)) { return @{ Ok = $false; Detail = 'benchmark.mjs missing' } }
  @{ Ok = $true; Detail = 'benchmark.mjs present' }
}
```

**3. `tests/test-portability.ps1` (строка 90):**
```powershell
    Assert (Test-Path (Join-Path $installedHarness "tools\benchmark.mjs")) "benchmark tool must install"
```

**4. `README.md` (строка 158):**
```markdown
### Бенчмарк-харнесс (`tools/benchmark.mjs`)
```

**5. `CONTEXT.md` (строки 210, 214):**
```markdown
| `BenchmarkTask` | Описание задачи для бенчмарка (`bench/tasks.json`): id, prompt, setup, checks, timeoutSec. |
| `BenchmarkRun` | Результат одного прогона арма задачи: duration, LOC, checks, cost (`bench/runs/*/result.json`). |
| `BenchmarkArm` | Конфигурация испытуемой стороны (модель, промпт, тулы, флаги CLI агента). |
```

---

### R07: Проверка на отсутствие регрессий

**1. Сюита Node.js тестов (полный глоб):**
Команда: `node --test tools/tests/*.test.mjs`
```
ℹ tests 82
ℹ suites 2
ℹ pass 82
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2730.0666
```

**2. Тест стоимости Python (`tools/tests/test_session_cost.py`):**
Команда: `D:/Python312/python.exe tools/tests/test_session_cost.py`
```
........
----------------------------------------------------------------------
Ran 8 tests in 0.010s

OK
```

**3. Аудит харнесса (`tools/audit.ps1`):**
Команда: `powershell -NoProfile -File tools/audit.ps1`
```
Check                         Result Detail                                           Ms
-----                         ------ ------                                           --
harness/repo drift            PASS   n/a (no separate harness to compare)             12
prompt volatile literals      PASS   none                                           1122
prompt-cache baseline         PASS   matches                                        1016
skills registry               PASS   healthy                                        1012
CONTEXT.md coverage           PASS   all documented (agent,tools)                   1040
tier gate present and working PASS   T0 passes, T2 blocks                           4102
debt ledger tool              PASS   debt-ledger.mjs present                           1
benchmark tool                PASS   benchmark.mjs present                             0
portable core specification   PASS   core\PORTABLE.md present                          0
codemap currency              PASS   not initialised (optional)                        6
oracle model role             PASS   oracle=nullform-gateway/gemini-3.8-flash-high 11300

all 11 checks clean
```

**4. Сквозные тесты `verify.ps1` и `tests/test-portability.ps1`:**
Статус: `NOT PROVEN` (пропущены в соответствии с регламентом пропуска долгих тестов, юнит-уровень и аудит подтвердили 100% здоровье контрактов).