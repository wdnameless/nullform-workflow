# Refactor w01 proposal

## Why
REFACTOR-PLAN.md волны 0 (мусор: 1.6 ГБ + ~2700 строк) и 1 (баги инструментов).
Обе низкорисковые, делаются одним T2.

## What changes
1. **garbage** (R01–R04): удаление biblicism-extractor, переименование 2
   скиллов, снятие мёртвых export, снос 15 смёрженных worktrees.
2. **toolbugs** (R05–R06): фикс maskJsCode tplStack, смягчение live-ledger
   до WARN/skip.

## Non-goals
- Сплиты монолитов (волны 2–4, отдельные changes).
- Архив 11 висячих openspec-changes (требует решения пользователя).
- Грязные worktrees (чужие незакоммиченные — не трогаем).
