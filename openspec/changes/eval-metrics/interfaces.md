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
