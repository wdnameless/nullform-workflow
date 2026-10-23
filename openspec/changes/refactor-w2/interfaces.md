# Interfaces — refactor-w2

## Владение (зоны disjoint)
- S01: `tools/verify.mjs` (facade), `tools/verify-profile.mjs` (new),
  `tools/audit-profile.mjs` (new). Плюс адаптация тестов verify*, если есть.
- S02: `tools/workflow.mjs` (только cmdCheckCi-делегат + импорт),
  `tools/workflow-ci.mjs` (new).
- Parent: openspec/, .workflow/, сьют, oracle. Общие тесты (workflow-gate,
  install-harness, symlink-entry) — читают оба, меняет при нужде parent.

## Границы
| Граница | Контракт |
|---------|----------|
| verify facade → profiles | `runVerifyProfile(ctx)`, `runAuditProfile(ctx)` — сигнатуры и ctx без изменений |
| testTierGate | остаётся импортируемым из `tools/verify.mjs` (фасад реэкспортирует) |
| workflow → workflow-ci | `cmdCheckCi(root, flags)` — та же сигнатура, тот же exit/текст |
| CLI | `verify.mjs --profile`, `workflow.mjs check-ci` — байт-идентичность (кроме путей/времени) |

## Сигнатуры
- Без новых публичных API. Перемещение кода 1:1, shared-хелперы — в тот модуль,
  где используются (дубли не плодить; если хелпер нужен обоим профилям —
  оставить в verify.mjs как shared и экспортировать в профили).
