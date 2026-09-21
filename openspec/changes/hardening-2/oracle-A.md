# Oracle-A — слепая приёмка изменения `hardening-2`

**ВЕРДИКТ: ACCEPT**

Слепота соблюдена: единственный источник требований — `openspec/changes/hardening-2/manifest.md`. `proposal.md`, `specs/**`, `interfaces.md`, `tasks.md`, `oracle-*.md` не открывались. Все команды запускались с явным cwd; где cwd не равен `D:/ohmypi/workflow-repo`, это указано в строке команды. Сырые выводы приведены дословно.

---

## 0. Раскрытие отклонения от read-only (обязательно к прочтению)

Первое воспроизведение находки `debt-ledger --write <каталог>` я выполнил как `--write docs` в корне репозитория; путь `docs` оказался не существующим каталогом, а свободным именем, поэтому инструмент создал файл. Это моя ошибка, не дефект продукта.

Доказательство, что файл создал я (cwd `D:/ohmypi/workflow-repo`):

```
powershell -NoProfile -Command Get-Item 'docs' | Select-Object Name,Length,CreationTime,LastWriteTime
Name          : docs
Length        : 137
CreationTime  : 9/21/2026 5:25:14 AM
LastWriteTime : 9/21/2026 5:25:14 AM
```

`git log --oneline -5 -- docs` вернул пустой вывод (exit 0); `git status --porcelain` содержал `?? docs` — файл никогда не был частью репозитория и был создан моим прогоном.

Состояние восстановлено: `powershell -NoProfile -Command "Remove-Item -Force 'docs' -ErrorAction Stop; Test-Path 'docs'"` → `False` (exit 0). Все дальнейшие репро выполнялись на временном дереве `D:/TMP/oa-oracleA`.

---

## R01 — протокол в роли, двойная приёмка, oracle-lite: PROVEN

Команда: `grep` по `agent/agents/oracle.md`, `agent/agents/orchestrator.md`, `agent/AGENTS.md` (cwd `D:/ohmypi/workflow-repo`).

`agent/agents/oracle.md:22` — `## EVIDENCE PROTOCOL (mandatory)`; пункты 1–5 дословно:

- `agent/agents/oracle.md:24` — `1. FILE CLAIM → exact path + line number + the verbatim line(s), quoted from a command output. ...`
- `agent/agents/oracle.md:25` — `2. BEHAVIOURAL CLAIM → the exact executed command + its raw output, with counts and exit codes AS PRINTED (never rounded, never restated in prose). ...`
- `agent/agents/oracle.md:26` — `3. CWD DISCIPLINE → run every command with an explicit cwd and state it. The session directory is NOT the repo; a command run from the wrong cwd proves nothing about the repo. ...`
- `agent/agents/oracle.md:27` — `4. NO PARAPHRASE → never translate, summarise, or write the output you "expected". Quote raw bytes. If a check cannot run (tool missing, no network, forbidden path), write NOT PROVEN: <check> — <reason> and stop; never infer its result.`
- `agent/agents/oracle.md:28` — `5. NUMBER CONSISTENCY → every summary number MUST appear verbatim in the raw output you quoted. ...`

Двойная приёмка и oracle-lite — `agent/agents/orchestrator.md:90` (дословно):

```
- Wave 4: @oracle blind acceptance & runtime verification — before spawning oracle run `node tools/oracle-model.mjs ensure --probe` and name the resolved model in the oracle spawn line. **Flash-class → Double Acceptance**: if the resolved model matches `*flash*` or is the configured fallback entry, a single pass is not acceptance — run **two independent oracle passes** and reconcile: ACCEPT requires both to agree; either `REJECT` forces a fix round (then a fresh pair). **Oracle-lite**: a single pass is permitted ONLY when the slice touches ≤2 files and the diff is ≤~80 lines — it follows the same evidence protocol as the full oracle (`agent/agents/oracle.md` § EVIDENCE PROTOCOL); anything larger goes through double acceptance. ...
```

Недельная ревизия памяти — `agent/AGENTS.md:60`:

```
- WEEKLY REVIEW (once a week): review the bank — prune stale or superseded memories, fold durable architectural decisions into `docs/adr/`, and keep only what still guides future work.
```

Дополнительно подтверждено исполнением: `powershell -NoProfile -File tools/audit.ps1` (cwd `D:/ohmypi/workflow-repo`) → строка `oracle model role             PASS   oracle=nullform-gateway/gemini-3.8-flash-high 1152` и итог `all 14 checks clean`, exit 0 — резолвнутая модель действительно flash-класса, то есть правило двойной приёмки активно, а не декоративно.

---

## R02 — охота по тулам: PROVEN (8 независимых воспроизведений)

Все репро запускались из `D:/ohmypi/workflow-repo`; фикстуры — в `D:/TMP/oa-oracleA`.

1. `node tools/benchmark.mjs run --runs 0 --yes` → `Ошибка: --runs требует целое число >= 1 (получено: 0).` — exit 2.
2. `node tools/benchmark.mjs run --runs abc --yes` → `Ошибка: --runs требует целое число >= 1 (получено: NaN).` — exit 2.
3. `node tools/domain-context.mjs --domain billing --max-files -1` → `Ошибка: --max-files требует целое число >= 1 (получено: "-1").` + `Использование: node tools/domain-context.mjs --domain <name> [--root <dir>] [--json] [--max-files 15] [--no-gh]` — exit 2.
4. `node tools/domain-context.mjs --domain billing --max-files 0` → `Ошибка: --max-files требует целое число >= 1 (получено: "0").` — exit 2.
5. `node tools/usage-audit.mjs --top` (флаг без значения) → `Ошибка: --top требует целое число >= 1 (получено: true).` + USAGE — exit 2.
6. `node tools/debt-ledger.mjs scan --root D:/TMP/oa-oracleA/ledger --write out` (цель — существующий каталог) → `Ошибка: не удалось записать реестр в D:\TMP\oa-oracleA\ledger\out (EISDIR).` — exit 2, стектрейса нет.
7. `node tools/benchmark.mjs run --root D:/TMP/oa-oracleA/bench --yes --cmd "echo hi" --runs 1` (фикстура с дублем id) → `Ошибка выполнения бенчмарка: Дублирующийся id задачи 'a' в D:\TMP\oa-oracleA\bench\bench\tasks.json: выбор задачи неоднозначен.` — exit 1.
8. `node tools/prompt-lint.mjs check --root D:/TMP/oa-oracleA/plint` (baseline.json = `{}`) → `prompt-lint: baseline is corrupt (missing "surfaces" object). Re-run `baseline`.` — exit 2.

Тесты (cwd `D:/ohmypi/workflow-repo`, `powershell -NoProfile -Command "node --test tools/tests/*.test.mjs"`), сырой хвост, exit 0:

```
ℹ tests 160
ℹ suites 2
ℹ pass 160
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 22796.5285
```

Проверка «тесты могли быть красными» (правило 5): старый код виден в диффе. `git diff -U1 -- tools/benchmark.mjs` (cwd `D:/ohmypi/workflow-repo`):

```
-          args.runs = parseInt(argv[++i], 10) || 1;
+          args.runs = parseInt(argv[++i], 10);
-          args.runs = parseInt(arg.slice(7), 10) || 1;
+          args.runs = parseInt(arg.slice(7), 10);
-  const runCount = Number(runs) > 0 ? Number(runs) : 1;
+  const runCount = runs == null ? 1 : Number(runs);
+    // Молчаливое «0/-1 → 1» раньше превращало --runs 0 в настоящий прогон бенчмарка.
+    if (!Number.isInteger(args.runs) || args.runs < 1) {
+      console.error(`Ошибка: --runs требует целое число >= 1 (получено: ${args.runs}).`);
```

Те же строки присутствуют и в живом харнессе (`D:/ohmypi/tools/benchmark.mjs:1048-1050`, проверено grep), то есть фикс задеплоен.
---

## R03 — инфра и prune: PROVEN

`node tools/doctor.mjs --harness D:/ohmypi/workflow-repo --json` (cwd `D:/ohmypi/workflow-repo`), exit 0:

```
  "summary": {
    "pass": 7,
    "fail": 0,
    "warn": 1,
    "skip": 1
  },
  "ok": true
{"id":"orphan-files","status":"skip","detail":"Харнесс является дистрибутивным репозиторием: файлов вне репозитория быть не может"}
```

`node tools/doctor.mjs --harness D:/ohmypi/workflow-repo --json --probe` (cwd тот же), exit 0 — WARN о провайдерах:

```
{"id":"provider-reachability","status":"warn","detail":"Недостижимые провайдеры: nullform-gateway (HTTP 502 Bad Gateway). Роли, указывающие на их модели: нет. роли вне models.yml не проверялись: openai-codex (default), opencode-go (smol, slow, plan, designer, task, advisor, oracle, fixer, explorer); Провайдер nullform-gateway недостижим: HTTP 502 Bad Gateway"}
  "summary": { "pass": 7, "fail": 0, "warn": 2, "skip": 1 }, "ok": true
```

Проверка орфанов на живом харнессе (repo-режим её честно пропускает, installed — нет): `node tools/doctor.mjs --harness D:/ohmypi --json` (cwd `D:/ohmypi/workflow-repo`), exit 0:

```
  "mode": "installed",
{"id":"orphan-files","status":"warn","detail":"24 файл(ов) харнесса отсутствуют в репозитории — прочие (24): agent/SYSTEM.md, agent/artifact_desktop_final.png, ... (+16)"}
  "summary": { "pass": 8, "fail": 0, "warn": 1, "skip": 0 }, "ok": true
```

Сухой прогон prune на временном дереве (cwd `D:/ohmypi/workflow-repo`), exit 0:

```
powershell -NoProfile -File tools/sync.ps1 -Prune -HarnessRoot D:/TMP/oa-oracleA/harness
prune: 2 candidate(s)
  [X] agent/ghost-role.md
  [X] tools/ghost-tool.mjs
sync: dry-run only - nothing was deleted. Re-run with '-Prune -Confirm' to delete.
```

Ничего не удалено — сразу после прогона: `Test-Path 'D:/TMP/oa-oracleA/harness/tools/ghost-tool.mjs'` → `True`, `Test-Path 'D:/TMP/oa-oracleA/harness/agent/ghost-role.md'` → `True`, листинг дерева содержит все 4 файла. Каталог `tools/settings.json` (суффикс из NEVER_SUFFIX) и `tools/doctor.mjs` (есть в репо) кандидатами не стали — границы работают.

Манифест-строка `sync.ps1` с `sync-prune.mjs` — `tools/sync.ps1:97`: `  'tools\sync-prune.mjs',`; проводка — `tools/sync.ps1:127-141`:

```
# ---------- -Prune: files the harness has and the repo does not ----------
# The candidate list comes from tools\sync-prune.mjs - the same module doctor.mjs
# uses for its `orphan-files` check, so the CLI and the diagnostic cannot drift
# apart. Dry-run by default; only -Confirm deletes. ...
if ($Prune) {
  $pruneScript = Join-Path $PSScriptRoot 'sync-prune.mjs'
  ...
  $pruneArgs = @($pruneScript, '--harness', $HarnessRoot, '--repo', $RepoRoot)
  if ($Confirm) { $pruneArgs += '--delete' }
```

---

## R04 — реестр навыков: PROVEN

`C:/Users/Administrator/.agents/.skills-disabled.json` (cwd `D:/ohmypi/workflow-repo`) — содержимое дословно:

```json
{
  "version": 1,
  "disabled": [
    "biblicism-extractor"
  ],
  "note": "reference-checked; designer palette and paseo-* kept by design"
}
```

`node tools/skills-doctor.mjs --installed C:/Users/Administrator/.agents/skills --repo D:/ohmypi/workflow-repo/skills --agents-home C:/Users/Administrator/.agents` (cwd `D:/ohmypi/workflow-repo`), exit 0:

```
skills-doctor: 67 installed, 68 in repo, 1 disabled by operator

  info
    biblicism-extractor: disabled by operator
...
  all checks passed (frontmatter, truncation, parity, orphans, names).
```

Размещение (cwd `D:/ohmypi/workflow-repo`): `skills/False`, `skills-disabled/ True`, `installed skills count: 67`, `disabled dir entries: biblicism-extractor`.

Installers skip-логика — `install.ps1:228-247`: `$disabledPath = "$agentsHome\.skills-disabled.json"`, `if ($disabledSkills -contains $_.Name) { $disabled += $_.Name; return }` и итог `Ok "skills: $copied installed$(...)$(if ($disabled) { ", $(($disabled).Count) disabled by operator skipped" })"`.

`mcp.json` живого агента (cwd `D:/ohmypi/workflow-repo`, node -e):

```
top-level keys: $schema,mcpServers
server keys: codebase-index,playwright,chrome-devtools,ast-grep,dap-debugger,codegraph,context7,hindsight,crawl4ai
contains test-mcp-renamed-2: false
```

90-дневный аудит (`node tools/usage-audit.mjs --days 90 --top 15`, cwd `D:/ohmypi/workflow-repo`, exit 0) воспроизводится: `Просканировано сессий: 224 (всего файлов: 224)`, `Обработано строк: 99581`, и список `--- НЕИСПОЛЬЗУЕМЫЕ УСТАНОВЛЕННЫЕ СКИЛЛЫ ---` из 37 имён (в том числе animate-expo, brand, copywriting, paseo-help, simplify). Перемещён по итогам решения оператора один — `biblicism-extractor`; остальные удержаны осознанно, что зафиксировано полем `note` в самом списке. Механизм доказан; объём перемещения — решение оператора, а не дефект.

---

## R05 — доки: PROVEN

`README.md:119` — `- **Двойная приёмка (double acceptance):** если разрешённая модель Оракула относится к flash-классу ... выполняются два независимых прохода приёмки, и вердикт ACCEPT выносится только при их согласии; любой REJECT запуска...`
`README.md:120` — `- **Oracle-lite:** сокращённый единственный проход приёмки допускается только для малого среза (≤2 файла и ≤~80 строк диффа) и следует тому же протоколу доказательств, что полный Оракул (раздел EVIDENCE PROTOCOL в agent/agents/oracle.md)...`
`README.md:121` — `- **Disabled skill (отключённый навык):** навык, перечисленный оператором в ~/.agents/.skills-disabled.json; tools/skills-doctor.mjs сообщает о нём как disabled by operator...`
`README.md:122` — `- **Prune (очистка):** tools/sync.ps1 -Prune перечисляет файлы каркаса, отсутствующие в репозитории, в пределах каталогов, покрытых манифестом. Удаление выполняется только с -Confirm; по умолчанию это dry-run. ...`
`README.md:131` — `powershell -File tools/sync.ps1 -Prune         # список кандидатов на удаление (dry-run; удаление только с -Confirm)`
`README.md:365-368` — `**Проверка провайдеров (--probe, опционально, требует сети):**`; `node tools/doctor.mjs --probe` ... `Недостижимый провайдер даёт WARN со списком затронутых ролей (никогда не FAIL — машина может быть офлайн).`; `Без --probe сеть не трогается: диагностика остаётся полностью локальной.`

`CONTEXT.md:50` — `- **Double acceptance** — the Wave 4 rule when the resolved oracle model is flash-class (name matches *flash* or is the configured fallback): two independent oracle passes, reconciled. ACCEPT requires the two to agree; either REJECT forces a fix round, then a fresh pair.`
`CONTEXT.md:51` — `- **Oracle-lite** — a single-pass Wave 4 acceptance permitted only for a small slice (≤2 files, ≤~80 diff lines), under the same evidence protocol as a full oracle pass. ...`
`CONTEXT.md:115` — `- **Disabled skill** — a skill named in ~/.agents/.skills-disabled.json (an operator's stop-list). tools/skills-doctor.mjs reports it as disabled by operator ...`
`CONTEXT.md:116` — `- **Prune** — tools/sync.ps1 -Prune: lists harness files absent from the repo within manifest-covered directories (dry-run by default), deleting only with -Confirm; never touches .prompt-lint, .workflow, .archmap, node_modules, worktrees, session or config files.`
`CONTEXT.md:132` — `- **Install doctor** — ... Its optional --probe (network) checks provider reachability in models.yml and that each config.yml role points at a reachable model; unreachable = WARN listing the roles, never FAIL...`
---

## R06 — первый реальный бенчмарк: PROVEN

Прочитаны `benchmark/README.md`, `report.txt`, `compare.txt` и все 8 `runs/*.json`.

Сходимость README ↔ raw `result.json` ↔ вывод инструмента (медианы по колонкам):

| Ячейка | durationMs в result.json | медиана в report.txt | README |
|---|---|---|---|
| csv-sum / oneshot | `"durationMs": 32552`, `"durationMs": 12958` | `22755ms` | `22.8s` |
| csv-sum / process | `"durationMs": 18567`, `"durationMs": 14854` | `16711ms` | `16.7s` |
| pagination-fix / oneshot | `"durationMs": 10676`, `"durationMs": 9868` | `10272ms` | `10.3s` |
| pagination-fix / process | `"durationMs": 11288`, `"durationMs": 8833` | `10061ms` | `10.1s` |

`linesAdded` в `result.json`: csv-sum oneshot `64` и `21` → report `+43/-0`, README `+43`; csv-sum process `22` и `29` → `+26/-0`, README `+26`; pagination оба арма `1`/`1` → `+1/-1`, README `+1/-1`. Во всех восьми файлах `"status": "ok"`, `"agentExit": 0` и `"checks": [ { "code": 0, "passed": true } ]` → `checks 4/4`.

Агрегат `compare.txt`: `Итог: -38.6% строк, -18.9% времени, checks 4/4 -> 4/4` — совпадает с README (`Aggregate: −38.6% lines, −18.9% time, checks 4/4 → 4/4`). Расхождений README против raw-артефактов не найдено.

Честность выборки: README, раздел `## Honest interpretation` — `**n=2 per cell on 2 toy tasks is not statistical evidence.**` — заявлено прямо.

Прогон реален, а не бумажный: `D:/TMP/bench-real/bench/runs/*/agent.log` существуют для всех 8 прогонов; в `csv-sum-oneshot-1/agent.log` лежит отчёт агента (`**Deliverable:** src/csv.js exporting sumColumn(csvText, columnName)`, `node --test test/csv.test.js` → **2/2 pass**), а в `csv-sum-process-1/agent.log` — дисциплина арма: `Known ceiling (commented in-file): naive split(",") ... defer: RFC 4180 quoting/escapes | ceiling: naive split(",") | upgrade: ...`. Армы действительно различались.

Наблюдение (не дефект): медиана LOC в ячейке csv-sum/oneshot математически равна `42.5`, process — `25.5`; и `report.txt`, и README печатают округлённые до целого `43` и `26`. README явно цитирует вывод инструмента (`report.txt` / `compare.txt`), поэтому это округление при выводе, а не подмена данных.

---

## R07 — без регрессий: PROVEN

| Проверка (cwd `D:/ohmypi/workflow-repo`) | Сырой итог | Exit |
|---|---|---|
| `node --test tools/tests/*.test.mjs` | `ℹ tests 160` / `ℹ pass 160` / `ℹ fail 0` | 0 |
| `D:/Python312/python.exe tools/tests/test_session_cost.py` | `........` / `Ran 8 tests in 0.011s` / `OK` | 0 |
| `powershell -NoProfile -File tools/audit.ps1` | `all 14 checks clean` | 0 |
| `powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1` | `27/27 checks passed` | 0 |
| `powershell -NoProfile -ExecutionPolicy Bypass -File tests/test-portability.ps1` | `All 11 portability regression tests PASSED successfully!` | 0 |

doctor: на дереве репозитория `"pass": 7, "fail": 0, "warn": 1, "skip": 1`, `"ok": true`; на живом харнессе — `"pass": 8, "fail": 0, "warn": 1, "skip": 0`, `"ok": true`. Формулировка манифеста «doctor 8/8» соответствует живому харнессу; в repo-режиме одна проверка `orphan-files` уходит в `skip` по конструкции.

`verify.ps1` поднимался на живом харнессе (`harness : D:\ohmypi`), при этом строка `harness/repo drift (when a repo clone is present)  PASS  clean` доказывает, что работающее дерево совпадает с репозиторием, а не что проверялась устаревшая копия.

---

## Гейты роли

- Deep Module Quality Gate / Deletion Test: `tools/sync-prune.mjs` не pass-through — он держит обход дерева и границы (`MANIFEST_DIRS`, `NEVER_DIRS`, `NEVER_SUFFIX`) и намеренно переиспользуется двумя потребителями (`doctor.mjs` → `orphan-files`, `sync.ps1 -Prune`), о чём прямо сказано в `tools/sync.ps1:128-130`. Удаление модуля размножило бы логику обхода по двум вызывающим — гейт пройден.
- Seam Check: шов — граница `findPruneCandidates({harness, repo})` (`tools/sync-prune.mjs:82-84`), вызываемая тестом, доктором и ps1; инкапсуляция не нарушена (модуль ничего не знает о doctor).
- Vocabulary Drift Gate: `CONTEXT.md` существует и покрывает новые операторские сущности теми же словами, что и код — `Double acceptance` (`CONTEXT.md:50`), `Oracle-lite` (`:51`), `Disabled skill` + путь `~/.agents/.skills-disabled.json` (`:115`), `Prune` + `-Confirm` (`:116`), `--probe` (`:132`). Терминов-синонимов не найдено. Модуль `tools/sync-prune.mjs` отдельной строкой по имени не вынесен — покрыт каноническим термином Prune, который использует и флаг, и модуль; трактую как отсутствие дрейфа.
- ADR Conflict: `docs/adr/` в репозитории отсутствует (`glob workflow-repo/**/adr/**` → `No files found matching pattern`), конфликтовать не с чем.
- Network Path Evidence (правило 10): дифф добавляет исходящий вызов `GET {baseUrl}/models` (`tools/doctor.mjs:17-21`, `:159-164`, `:881-888`). Кассеты в репозитории нет — `glob workflow-repo/**/*cassette*` совпадений не дал, поэтому формально это не cassette-доказательство. Вместо мока путь исполнен живьём: `--probe` вернул `Недостижимые провайдеры: nullform-gateway (HTTP 502 Bad Gateway)` — реальный ответ сети на реальный запрос, а не подделка; юнит-проверка `probeProviders: живой /models → reachable, мёртвый порт → unreachable` поднимает настоящий локальный сокет.
- HYPOTHESIS DISCLOSURE (правило 11): работа не закоммичена (`git log --oneline -5` → верхний `5b6f983 chore(openspec): close task lists for benchmark, archmap-removal and tkach-adoption`; `git status --porcelain` показывает ` M tools/...` и `?? openspec/changes/hardening-2/`), поэтому коммита/PR с гипотезой не существует. Причина каждого фикса при этом выписана прямо в диффе (`tools/benchmark.mjs:1047`: `// Молчаливое «0/-1 → 1» раньше превращало --runs 0 в настоящий прогон бенчмарка.`; `tools/domain-context.mjs:487-488`: `// Молчаливое parseInt(...) || 15 превращало --max-files 0|abc в 15, а --max-files -1 — в slice(0, -1) с потерей последнего файла.`) и в архиве бенчмарка (`benchmark/README.md`: `Two defects in the harness itself were found by this run and fixed before the numbers above were taken: (1) metrics silently reported zero when git add -A failed ... (2) tool-generated directories ... were counted as the agent work.`). Требование «следующий отладчик должен узнать причину» выполнено в самом диффе; отсутствие коммита фиксирую как наблюдение к процессу, а не как дефект изменения.

---

## NOT PROVEN (явно, без догадок)

1. NOT PROVEN: повторный прогон бенчмарка R06 через `omp -p` — не запускался (8 платных прогонов на удалённой фикстуре); вместо этого проверены архивные `agent.log`, доказывающие, что прогоны состоялись.
2. NOT PROVEN: сетевой путь probe против живого провайдера не покрыт кассетой — кассеты в репозитории нет; путь проверен живым HTTP-ответом (502) и живым локальным сокетом в юнит-тесте.
3. NOT PROVEN: восстановление oracle-модели через omniroute — вне non-goals и без сети; зафиксирован только фоллбэк gemini-3.8-flash-high (audit.ps1, строка `oracle model role`).

---

## Сводка по строкам манифеста

| ID | Статус | Ключевое доказательство |
|---|---|---|
| R01 | proven | `oracle.md:22-28`, `orchestrator.md:90`, `AGENTS.md:60` |
| R02 | proven | 8 репро с кодами 2/2/2/2/2/2/1/2; `pass 160 fail 0`; старый код виден в `git diff` |
| R03 | proven | `doctor --json` ok:true; `--probe` WARN + exit 0; `prune: 2 candidate(s)` и файлы на месте; `sync.ps1:97,127-141` |
| R04 | proven | `.skills-disabled.json`; `1 disabled by operator` exit 0; skills/False + skills-disabled/True; `test-mcp-renamed-2: false` |
| R05 | proven | `README.md:119-122,131,365-368`; `CONTEXT.md:50-51,115-116,132` |
| R06 | proven | медианы README = `report.txt` = raw `result.json`; `-38.6% / -18.9%`; все 8 логов агента на диске |
| R07 | proven | 160/160, 8/8 python, `all 14 checks clean`, `27/27 checks passed`, `All 11 portability regression tests PASSED` |