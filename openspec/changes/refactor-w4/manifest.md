# Refactor wave 4 — requirements

User ask (verbatim): "делай" (волна 4 из REFACTOR-PLAN.md) +
"Я хочу красивый, рабочий код и удалить весь мусор".

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «красивый, рабочий код» — сплит dashboard | tools/dashboard.mjs 4037 → dashboard-collectors.mjs (~1700) + dashboard-ui.mjs (~1265, generateDashboardHtml) + dashboard.mjs server/CLI (~1050). Все 28 тестовых импортов резолвятся (прямо/реэкспорт); dashboard.test + autoreview + u-waves зелёные; живой /api/state + /api/health + freeze работают. | verified |
| R02 | «удалить весь мусор» — унификация JSONL | Один модуль tools/session-log.mjs (readJsonlSafe/findNewest/transcript-tokens); dashboard + cache-doctor + cost-snapshot + measure-session используют его (дубли удалены ~200 строк); их тесты зелёные. | verified |

Scope: волна 4. Out of scope: изменение UI/API поведения, сплит тестов.
