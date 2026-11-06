# Manifest — P1+P2 adoption

Source: user «Давай брать p1 и p2» (2026-11-06), вытекает из
`.tmp/recon-video-8YeTA1Ua.md` (видео 8YeTA1Ua_Ys, Ник Фролов, JetBrains Junie).

criticality: supporting

## Requirements

| ID | Requirement | Verbatim quote | verify | Status |
|----|-------------|----------------|--------|--------|
| R01 | Манифест связывает требование с проверкой: колонка `verify`, mechanical-check, oracle сверяет | "если наши реквайрменты живут вместе с кодом, то мы можем как бы и тестирование осуществить" | `node --test tools/tests/manifest-verify.test.mjs` | in-spec |
| R02 | Adversarial-режим ревью: ≥3 сценария отказа с доказательством, а не подтверждение | "другой будет adversary... ему нужно найти, почему нет" | `node --test tools/tests/reviewer-modes.test.mjs` | in-spec |
| R03 | Cost per lane: потолок `maxCostUsd`, фактическая стоимость в метрике и статусе, cost не отменяет тесты | "если ему нужно ещё оптимизировать параметр коста... тест не сработал, я его заскипал" | `node --test tools/tests/lane-cost.test.mjs` | in-spec |
| R04 | Perf-чек для горячих путей: замер до/после или `n/a` с причиной | "если у тебя перформанс тестер там раниться" | `node --test tools/tests/perf-gate.test.mjs` | in-spec |
| R05 | Cross-model critique: второй проход другой моделью, расхождение = эскалация, без флага не активен | "нужно использовать разные модели... просить их друг друга отревать" | `node --test tools/tests/cross-model.test.mjs` | in-spec |

## Constraints

- C1: 70+ существующих манифестов без колонки `verify` не ломаются (условное правило).
- C2: отсутствие тарифов cost → `unverified`, не `pass`.
- C3: cross-model только по явному флагу и при admitted-провайдере; иначе UNVERIFIED.
- C4: cost-оптимизация никогда не отменяет зелёные тесты (правило в промптах ролей).
- C5: perf-гейт применяется только к горячим путям, не ко всем диффам.
- C6: правки промпт-поверхностей только по явному разрешению пользователя.

## Acceptance
- A1: манифест с колонкой `verify` без значения → `workflow check` отказ.
- A2: reviewer adversarial выдаёт структуру с ≥3 сценариями отказа.
- A3: `budgets.json maxCostUsd` соблюдается; превышение видно в status/метрике.
- A4: perf-гейт срабатывает на dashboard-diff и молчит на docs-diff.
- A5: cross-model при отсутствии флага — no-op; при расхождении — эскалация.
