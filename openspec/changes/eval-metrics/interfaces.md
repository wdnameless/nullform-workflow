# Interfaces: eval-metrics (пункт 1: pass@k/pass^k)

## Зона владения
- `tools/benchmark.mjs`: `summarizeRuns` (добавить passAtK/passPowK на task×arm), `compareArms` (дельты метрик), `formatReport`/`formatCompare` (колонки), экспорт `computePassK(results)`.
- `tools/tests/benchmark.test.mjs`: фиктивные раны (A:5/5, B:4/5, C:1/5, D:0/5 — пример из видео) → assert pass@5/pass^5.
- Один владелец (fixer), один файл кода + один тест. Остальное не трогать.

## Контракты
- Определение «решена»: все checks задачи pass (существующее, не менять).
- `passAtK(task,arm) = 1` если ≥1 ран решён, иначе 0; по набору — доля.
- `passPowK(task,arm) = 1` если все K ранов решены, иначе 0; по набору — доля.
- K = фактическое число ранов в данных (не флаг); при K=1 обе метрики = pass.
- JSON-вывод report/compare расширяется полями, старые поля не переименовывать.

## Пункт 2: PR-смок (R02)
- `bench/tasks.json`: 4 → ~10 задач; 6 новых из fail-taxonomy реальных сбоев (категории: verdict-парсинг, frozen-test инвариантность, double-oracle согласие, worktree изоляция, prompt-бюджеты, code-size потолки — финальный выбор за исполнителем, стиль как у eval-*).
- `tools/benchmark.mjs`: команда `smoke --baseline <runsDir> --candidate <runsDir> [--tasks a,b] [--json]`; правило: задача красная если baseline K/K а candidate 0/K; exit 1 при любой красной, иначе 0. Плюс `validate-tasks` (схема tasks.json: уникальные id, валидный tier, непустые checks, timeout>0; exit 2).
- `bench/fixtures/smoke/{baseline,candidate}/`: минимальные result.json для red/green путей smoke в CI.
- `.github/workflows/repo-gate.yml`: джоба `bench-smoke` — validate-tasks + smoke на фикстурах (оба пути) + benchmark unit-тесты.
- Тесты в `tools/tests/benchmark.test.mjs`: smoke red/green/edge (baseline не идеален → не красный; отсутствующая задача → skip), validate-tasks ok/bad, tasks.json = 10 валидных.
