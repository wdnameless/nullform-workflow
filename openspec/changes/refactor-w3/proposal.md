# Refactor w3 proposal

## Why
REFACTOR-PLAN.md волна 3: doctor.mjs 1430 (runDoctor 743) и
benchmark.mjs 2016 (main 251, compareArms 304). Средний риск.

## What changes
1. **doctor-split** (R01): doctor-checks.mjs + тонкий runDoctor.
2. **bench-split** (R02): bench-analytics.mjs + bench-smoke.mjs +
   ядро benchmark.mjs + роутер main.

## Non-goals
- Изменение поведения CLI, JSON, exit-кодов, порядка checks.
- Волна 4 (dashboard).
