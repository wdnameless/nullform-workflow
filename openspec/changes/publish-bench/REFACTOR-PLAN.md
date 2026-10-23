# Слабые места и план рефакторинга (2026-10-23)

Источники: code-size scan (33 нарушителя), debt-ledger (155/0), doctor (9/4/0),
два скаута (DeadCodeHunt, StructDebt), ручная проверка.

## A. Слабые места (факты)

### A1. Монолиты (структурный долг)
| Файл | Строк | Ядро проблемы |
|---|---|---|
| tools/dashboard.mjs | 4039 | 3 слоя в одном: collectors ~1730 + UI-шаблон ~1265 + server/CLI ~1040 |
| tools/workflow.mjs | 2383 | CI-блок 1670–2249 (~580) внутри ядра |
| tools/benchmark.mjs | 2017 | main 251 строк switch; compareArms 304 дублирует smoke |
| tools/doctor.mjs | 1431 | runDoctor 616–1358 (743 строки, 16 проверок подряд) |
| tools/verify.mjs | 1285 | 2 независимых профиля: verify 555 + audit 226 |
| tools/oracle-model.mjs | 796 | run 210; 6 утилит с 0 внешних вызовов |
| tools/tests/doctor.test.mjs | 1502 | тесты зеркалят монолит |
| tools/tests/workflow-gate.test.mjs | 1089 | тесты зеркалят монолит |

### A2. Мёртвый код и дубли (~1500 строк + 1.6 ГБ)
- benchmark.mjs: 22 из 26 экспортов мертвы вне тестов (~500 строк).
- oracle-model.mjs: дубликат assignChecker/resolveOracleModel + 6 util с 0 вызовов (~390 строк).
- usage-audit.mjs: все 8 экспортов только для CLI/тестов (~350 строк снять export или фасад).
- benchmark vs benchmark-run vs measure-session: тройной парсинг session/metrik + дубли normalizedCost (~300 строк).
- cost-snapshot vs session_cost.py vs dashboard vs cache-doctor: 4× парсинг JSONL (~200 строк).
- return-contract ALLOWED_STATUSES/REQUIRED_SECTIONS дублирует worker-contract (~30 строк).
- biblicism-extractor: чужой мёртвый скилл ~1200 строк, отключён в .skills-disabled.json.
- Битые имена: frontend-design-anthropic (name: frontend-design), industrial-brutalist (name: industrial-brutalist-ui).
- .tmp/: 1.6 ГБ, 38+ worktrees (795М), venv, ci-candidate-*, tgz. Gitignored, но жрёт диск.
- openspec/changes/: 43 директории, 11 без финального оракула (висят открытыми).

### A3. Баги инструментов
1. **code-size сканер, строка 121**: `${` перезаписывает tplStack[top]=0 +
   внедряет фальшивые `{`/`}` в cleanLines → фантомный esc() 925 строк.
   Триггер: R13 добавил интерполяции в UI-шаблон.
2. **quality-evidence live-ledger**: тест падает от env-данных
   (35 vs 18 settled в gitignored bench/runs/spend-ledger.json).
   Хрупкая связка «исторический тест ↔ живой файл».

### A4. Варнинги доктора (4, все объяснены)
- agent-wiring: repo привязан к D:/ohmypi, не к репо (режим repo, норма).
- prompt-baseline: дрейф промптов код 1 (требует ревизии baseline).
- agents-drift: reviewer/sonic перекрывают встроенных (first-wins, осознанно).
- version-alignment: бинарник v1.3.0 vs установка v1.2.0 pending (лечится nullform update).

## B. План рефакторинга (5 волн, T2 каждая или 1×T3)

### Волна 0 — мусор (быстро, без риска) [~1.6 ГБ + ~1200 строк]
1. Удалить biblicism-extractor целиком (мёртв, отключён).
2. Починить имена frontend-design-anthropic, industrial-brutalist.
3. Снести export с мёртвых функций (benchmark 22, oracle-model 6+дубликат,
   usage-audit фасад, return-contract дубликат) + адаптация тестов на CLI.
4. `git worktree prune` + удаление .tmp/worktrees старше 7 дней БЕЗ
   незакоммиченных изменений (проверка `git status` в каждом!).
   Осторожно: 38 worktrees могут держать чужие ветки — только prune + stale.
5. Архивировать 11 висячих openspec-changes в openspec/changes/archive/
   или довести до оракула (решает пользователь).

### Волна 1 — баги инструментов (точечно)
6. code-size maskJsCode: push/pop вместо перезаписи tplStack[top],
   не внедрять `{`/`}` в out. Тест: шаблон с `${}` + стрелочные функции.
   Убрать `code-size:allow` с esc после фикса.
7. quality-evidence: live-ledger проверка → WARN вместо FAIL при дрейфе
   env-файла, или тест на фикстуре вместо живого корня.

### Волна 2 — сплит verify + workflow-ci (средний риск)
8. verify.mjs → verify-profile.mjs (555) + audit-profile.mjs (226) +
   фасад verify.mjs ~300. Инвариант: CLI `verify.mjs --profile` + JSON.
9. workflow.mjs 1670–2249 → workflow-ci.mjs (~580); cmdCheckCi — делегат.
   Инвариант: repo-gate.yml, workflow-gate.test.mjs зелёные.

### Волна 3 — сплит doctor + benchmark (средний риск)
10. doctor.mjs runDoctor → doctor-checks.mjs (6 доменных функций);
    runDoctor ~50 строк. Инвариант: порядок checks[].id, summary.
11. benchmark.mjs → bench-analytics.mjs (~450) + bench-smoke.mjs (~150);
    main → роутер ~40 строк. Инвариант: benchmark.test.mjs + bench-smoke в CI.

### Волна 4 — сплит dashboard (высокий риск, последний)
12. dashboard.mjs → dashboard-collectors.mjs (~1700) +
    dashboard-ui.mjs (~1270) + dashboard.mjs server/CLI (~1040).
    Инвариант: фасад реэкспортирует 38+ символов для dashboard.test.mjs
    + dashboard-autoreview.test.mjs. Параллельно: сплит тестов
    (dashboard-run.test.mjs по defer-маркеу).
13. Унификация парсинга JSONL: один модуль session-log.mjs вместо 4×
    (dashboard, cache-doctor, cost-snapshot, session_cost.py-мост).

### Порядок и гейты
- Волны 0–1: можно подряд, каждая с node --test затронутых + code-size check.
- Волны 2–4: каждая отдельным change с blind oracle (как слайсы universal-1).
- Финальный гейт: code-size scan 0 нарушителей без exempt + doctor OK +
  полный сьют зелёный (кроме известного live-ledger, чинится в волне 1).

## C. Что НЕ трогать
- oracle-model run 210 строк: работает, покрыт; только снять дубликаты (волна 0).
- usage-audit auditUsage 316: CLI-инструмент, не прод-путь; только фасад.
- skills/design-system, ui-ux-pro-max: большие, но живые; вне scope.
- Чужие worktrees с незакоммиченным: спросить владельца, не сносить.
