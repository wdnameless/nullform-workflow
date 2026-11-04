# s4-matrix — proposal

## Why
Программа refactor-program требует доказуемого подтверждения качества на разных системах, харнессах и моделях:
1. CI ранее запускал тесты и линт только на Ubuntu Node 22 (win/mac — только tarball certify; Node 18/20 не проверялись).
2. Install smoke job в CI отсутствовал.
3. `verify.mjs` хардкодил путь к OMP (`~/.omp/agent`) и не поддерживал другие харнессы.
4. `bench-budget.mjs` содержал тарифы только для 2 моделей Gemini и жесткий потолок $1, без поддержки категорий strict/builder/scout и ролей model-router.
5. `bench/tasks.json` требовал расширения матричными кейсами.

## What Changes
- `.github/workflows/repo-gate.yml`: добавлены кросс-платформенные test-cells (Windows/macOS × Node 18/20/22/24 с тестами и линтом) и `install-smoke` job для чистой VM.
- `tools/verify.mjs` и `tools/verify-profile.mjs`: аргумент `--harness claude|codex|opencode` с динамическим разрешением каталогов, остальные 5 харнессов OUT.
- `tools/bench-budget.mjs` и `tools/model-router.mjs`: тарифы категорий strict/builder/scout × 9 ролей, admission policy, потолок программы $50.
- `bench/tasks.json`: добавлены новые matrix-кейсы (append-only).

## Non-Goals
- Изменение логики core-воркфлоу (S1/S2/S3).
- Поддержка харнессов вне стандартной матрицы (cursor, openclaw, hermes, openhuman, omp — OUT).
- Платные сетевые вызовы моделей в рамках слайса (spend $0.00).
