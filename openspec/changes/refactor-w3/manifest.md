# Refactor wave 3 — requirements

User ask (verbatim): "делай" (волна 3 из REFACTOR-PLAN.md) +
"Я хочу красивый, рабочий код и удалить весь мусор".

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «красивый, рабочий код» — сплит doctor | runDoctor 743 → оркестратор ≤100 строк; 16 проверок → tools/doctor-checks.mjs как (ctx) => check. Порядок checks[].id, summary, все 15 экспортов инвариантны; doctor.test.mjs + зависимые (adaptive-harness-cli, portable-runtime, self-update) зелёные; CLI golden match. | verified |
| R02 | «красивый, рабочий код» — сплит benchmark | tools/benchmark.mjs 2016 → bench-analytics.mjs (summarizeRuns/compareArms ~450) + bench-smoke.mjs (runSmoke/validateTasks ~150) + ядро ~1400; main → роутер ≤60 строк. Экспорты для run-skill-benefit-eval/lm-replay/benchmark.test инвариантны; benchmark.test.mjs зелёный; CLI golden match. | verified |

Scope: волна 3. Out of scope: волна 4 (dashboard), изменение поведения.
