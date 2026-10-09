# eval-metrics — proposal

## Why
Видео bFHCK6PB0hA: одиночный прогон агента ничего не говорит о стабильности.
Наш benchmark гоняет `--runs N`, но агрегирует только медианы — разброс теряется.

## What changes (пункт 1 из 4)
Добавить в `report`/`compare` метрики pass@k и pass^k по каждому task×arm и по набору.
Дефолт `--runs 1` не меняется (обе метрики при K=1 вырождаются в pass).

## Non-goals (пункты 2–4, следующие заходы)
PR-смок, record/replay LM, калибровка oracle.
