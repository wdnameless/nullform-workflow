# Refactor w4 proposal

## Why
REFACTOR-PLAN.md волна 4 (высокий риск, последний монолит):
dashboard.mjs 4037 — collectors ~1700 + UI-шаблон ~1265 + server/CLI ~1050.
UI независим (0 кросс-ссылок) — чистый разрез. Плюс унификация 4× JSONL.

## What changes
1. **dashboard-split** (R01): collectors + ui + server/CLI с реэкспортом.
2. **jsonl-unify** (R02): session-log.mjs, 4 потребителя, дубли удалены.

## Non-goals
- Изменение UI, API, CLI поведения.
- Сплит dashboard.test.mjs (defer-маркер уже стоит).
