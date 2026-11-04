# refactor-program — proposal

## Why
Репо упёрся в потолки: `tools/workflow.mjs` 2500/2500 (тикет #16 OPEN, запас 0),
`dashboard-ui` дрейфует (+23 сверх defer), `quality.mjs` −103, COCO `sync:main`
315 при лимите 200, 9 unwired-модулей без прод-коллеров. Доказательства при этом
узкие: тесты/линт только на ubuntu Node 22, win/mac — лишь tarball-certify;
`verify` знает только OMP из 9 харнессов; тарифы — 2 Gemini; живые model-evals
в CI отсутствуют. Пользователь: "красивый и поддерживаемый код... доказуемо на
разных системах и харнессах и агентах и ии моделях". Wave 0: слайсами с oracle,
expand-contract с нулём поведения, бюджет $50, только код репо.

## What Changes
- **S1 workflow-split (R01+R02)**: `workflow.mjs` 2500 → 3 файла <1200
  (workflow-ci / workflow-core по плану #16). Expand-contract, тесты заморожены.
- **S2 dashboard-family (R01+R02)**: dashboard-ui к 1570 с запасом, collectors
  +18 удержать, тесты dashboard.test/benchmark.test в defer-потолки.
- **S3 gates-coco-prune (R01+R02)**: quality.mjs к 700, sync:main и auditUsage
  под 200, prune 9 unwired (только с grep-доказательством 0 коллеров).
- **S4 proof-matrix (R03+R04+R05)**: CI win/mac test-cells, Node 18/20,
  install smoke job, verify claude/codex/opencode, тарифы категорий × роли.
- **S5 behavior-deltas (R06)**: bench было→стало на S1–S3 (lead-time/CFR/
  bench-compare), отчёт + честный `not-proven` без парных A/B.

## QA-план
Контракты: (1) `openspec validate refactor-program --strict` exit 0;
(2) каждый слайс — свой T2 с blind oracle против слайс-манифеста;
(3) Stage B disposition на каждом кодовом слайсе (S1–S3);
(4) финальный интеграционный oracle против программного манифеста R01–R06.
Чёрный ящик: гейты с маржой ≥5%; CI зелёный на новых ячейках; spend ≤$50.
Меняется в тестах: только move/split вслед за кодом; новых поведенческих
тестов ноль (риск-граница), кроме S4-matrix и S5-bench.

## Non-Goals
- Промпт-поверхности (AGENTS.md, роли, скиллы) — OUT (Wave 0: только код репо).
- npm-релиз, доки сайта, миграции пользователей — OUT.
- Поведенческие изменения, редизайн, новые фичи — OUT (ноль поведения).
- Полная матрица "все × все" — OUT (стандарт: +macOS, Claude/Codex/OpenCode).
- Парные A/B влияния на качество моделей — OUT (PORTABLE §9: `not-proven`).
