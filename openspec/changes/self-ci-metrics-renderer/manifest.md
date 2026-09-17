# Requirements — self-hosted CI + metrics + renderer split

User original: «Делай» — approval of the three proposals from the preceding message (workflow self-evaluation):
1. «Применить CI-шаблон к самому репо — закрывает лицемерие "шаблон есть, самим не пользуемся"»
2. «Метрика ценности — логировать длительность задачи и пост-релизные фиксы; без этого "улучшения workflow" неотличимы от ритуала»
3. «Разделить archmap-report.mjs на шаблон/стили/скрипт — собственный инструмент перестанет быть контрпримером»

| ID | Requirement (approved scope) | Acceptance | Status |
|---|---|---|---|
| R01 | CI on this repo itself | `.github/workflows/` runs on push/PR: npm ci tools, node --test, openspec validate (if changes), archmap scan, auto-review, workflow gate presence | in-spec |
| R02 | Task value metrics | workflow.mjs appends lifecycle to `.workflow/metrics.jsonl` on close (tier, task, startedAt, closedAt, durationMs, forced, auto); `metrics` command prints totals by tier + avg duration. Post-release regression linkage is OUT (no reliable signal yet) — stated honestly | in-spec |
| R03 | Split renderer | `renderHtml(state,delta,findings)` facade unchanged; client JS becomes a real file `tools/report/client.js` (kills template-escape bug class), CSS `tools/report/page.css`, server helpers stay in renderer; install/sync ship the new files; generated HTML byte-comparable in behavior (all QA passes) | in-spec |
| R04 | No regressions | 27 existing tests + verify 24/24 stay green; report test suite passes; jsdom QA equivalent | in-spec |

Non-goals: regression-to-task linkage (no data source), Windows-only installer (separate task), dashboard (R09e, still deferred).
