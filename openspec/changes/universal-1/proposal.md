# Universal workflow #1 — proposal

## Why
SCORING.md: Autopilot 84.1 vs Nullform 80.8. Отставание в briefing (−3),
нарезке (−2), метриках (−2), установке (−4). Пользователь требует закрыть
все четыре + умную установку с самопроверкой + качество по всем осям.

## What changes (9 requirements, 4 slices)

1. **A smart-install** (R01–R04): детект установки/версии, upgrade с
   rollback, детект конфликтов (WARN + совет), doctor-lite в start/check.
2. **B briefing-rounds** (R05): `workflow brief --rounds N`, CLI-раунды,
   addenda в manifest, рекомендованные ответы.
3. **C waves+bench** (R06–R07): волны/бары в run-view, калибровка ~3K,
   benchmark-прогон + docs/benchmark.md.
4. **D skills+quality** (R08–R09): полный SKILL.md, quality gates
   (size/lint/debt/hygiene) в check-ci.

## Non-goals
- Авто-карантин/удаление чужих workflow (только WARN + совет).
- Дашборд-блок вопросов (брифинг CLI-only по Wave 0).
- Живое сравнение с autopilot-прогоном (только синтетика).

## Reuse first
- install-harness.mjs, installation/state.mjs, doctor.mjs, journal.mjs,
  plan-check.mjs, cost-snapshot.mjs, dashboard.mjs run-view, skills-doctor.mjs.
