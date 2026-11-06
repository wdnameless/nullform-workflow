# p1p2-adoption — proposal

## Why
Аудит видео 8YeTA1Ua_Ys показал пять пробелов: манифест не связывает требование
с проверкой, ревью не имеет adversarial-режима, нет долларового потолка на lane,
performance исключён из ревью, кросс-модельная критика не автоматизирована.
Остальные идеи видео у нас уже реализованы или неприменимы (см. recon).

## What Changes
- **R01**: колонка `verify:` в таблице требований, проверка в
  `validateManifestRows`, требование к oracle сверять verify.
- **R02**: `--mode adversarial` для review-run и секция в `reviewer.md`:
  ≥3 сценария отказа с доказательством.
- **R03**: `maxCostUsd` в `budgets.json` (+`tiers`), фактическая стоимость в
  метрике close и в `status`/`check-budget`; правило «cost не отменяет тесты».
- **R04**: perf-чек в reviewer для горячих путей (замер или `n/a` с причиной).
- **R05**: `oracle --cross-model` — второй проход другой моделью, расхождение
  вердиктов = эскалация; без флага no-op.

## Non-Goals
- Семь ревью-агентов на каждый PR, Jira/MCP-синхронизация требований,
  автооптимизация стоимости агентом, token-leaderboards как KPI.
- Замена человека в принятии решений; live-модельные прогоны без credentials.

## QA plan
Каждое требование: red-before/green-after тест. Обратная совместимость
манифестов проверяется на существующем `openspec/changes/**`. Гейты:
`quality check`, `code-size check`, focused suites. Blind oracle по R01–R05.
