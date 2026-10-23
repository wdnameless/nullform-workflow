# Refactor w2 proposal

## Why
REFACTOR-PLAN.md волна 2: verify.mjs 1284 (2 профиля) и workflow.mjs 2382
(CI-блок ~580 внутри ядра). Средний риск, чёткие границы.

## What changes
1. **verify-split** (R01): verify-profile.mjs + audit-profile.mjs +
   фасад verify.mjs ≤400 строк.
2. **workflow-ci-split** (R02): workflow-ci.mjs (~580) + делегат cmdCheckCi.

## Non-goals
- Изменение CLI-поведения, JSON-форматов, exit-кодов.
- Волны 3–4.
