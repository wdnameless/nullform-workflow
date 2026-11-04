# refactor-program — interfaces

## S1: workflow-split (owner: @fixer, worktree feature/s1-workflow-split)

- Разрез по плану #16: CI-поверхность (`check-ci`, `review-run`, валидаторы)
  → `tools/workflow-ci.mjs`; lane-ядро (start/artifact/check/close/ask/metrics)
  остаётся в `tools/workflow.mjs`; общее состояние/журнал → `tools/workflow-core.mjs`
  (только если >200 строк, иначе в workflow.mjs).
- Каждый файл <1200 строк; `bin/nullform.mjs` passthrough байт-идентичен.
- Expand-contract: новые модули рядом → миграция вызовов пакетами → удаление
  старого только при 0 референсов (`grep` доказательство).
- Тесты: workflow-gate.test.mjs — move only; Stage B disposition обязателен.
- Baseline: обновить только s1-строки (workflow*) с датой+причиной.

## S2: dashboard-family (owner: @fixer, worktree feature/s2-dashboard)

- dashboard-ui.mjs → ≤1570 с запасом ≥5% (вынос arch tab в client-модуль
  по defer-триггеру, триггер уже сработал: 1593/1570).
- dashboard-collectors.mjs удержать ≤1697 (запас +18 не съедать).
- dashboard.test.mjs → ≤1800, benchmark.test.mjs → ≤1200 (сплит файлов
  тестов, не ресид: тесты делятся без потери покрытия).
- Поведение: рендер байт-в-бит (сверка HTML-снапшота до/после).

## S3: gates-coco-prune (owner: @fixer, worktree feature/s3-gates)

- quality.mjs → ≤700 с запасом (разрез CLI/engine по defer-триггеру).
- sync.mjs:main 315 → ≤200; usage-audit auditUsage 208 → ≤200 (сплит
  функций, не ресид: COCO ресидится только вниз).
- Prune 9 unwired: каждый — grep-доказательство 0 прод-коллеров в коммите;
  удаление + чистка CODEMAP/индексов; тесты мёртвых модулей удалить вместе.
- Baseline/COCO: только вниз (min-recorded), без ресидов вверх.

## S4: proof-matrix (owner: @fixer, worktree feature/s4-matrix)

- repo-gate.yml: win/mac test-cells (tests+lint, не certify-only) + Node 18/20
  в матрицу; install smoke job (install + verify в чистой VM).
- verify: `--harness claude|codex|opencode` вместо хардкода OMP-пути;
  остальные 5 харнессов — OUT (матрица стандарт).
- bench-budget.mjs: тарифы strict/builder/scout × роли; ledger + admission
  policy; суммарный spend программы ≤$50 (счётчик в S5).
- bench/tasks.json: append-only новые matrix-кейсы (старые не трогать).

## S5: behavior-deltas (owner: @sonic, worktree feature/s5-deltas)

- Замеры на S1–S3: lead-time (start→close), CFR (fix/feat окна), bench-compare
  baseline-vs-slice; сырые выводы команд в отчёт.
- Отчёт доказательства: `bench/runs/refactor-program/` + append в
  docs/benchmark-live.md; каждая дельта — raw evidence или `not-proven`.
- Spend-учёт: суммарный model-spend слайсов ≤$50 (ledger-выписка в отчёт).
- Без кода продукта: только замеры, отчёт, append'ы.

## Shared contracts (parent-owned)

- Зоны disjoint (см. tasks.md); пересечение = NEEDS_CONTEXT родителю.
- Каждый слайс: свой T2 (мини-манифест R## + blind oracle слайса).
- Stage B на S1–S3: `stage-b --phase before/after`, disposition в evidence.
- Spend: каждый model-вызов через ledger; $50 — жёсткий потолок программы.
