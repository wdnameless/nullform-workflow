# Interfaces: session-safety-nets

## Новые поверхности
- `agent/extensions/nullform-delete-guard.ts` — OMP extension, `pi.on('tool_call')` для `bash`/`eval`:
  `matchDestructiveCommand(cmd) -> {what} | null`; `ctx.ui.confirm(title, message) -> bool`.
  Доставка: `tools/install-harness.mjs` копирует рядом с `nullform-jev.ts`.
- `tools/workflow.mjs`: `cmdStatus` + budget-блок; новая команда `check-budget [--sessions <dir>] [--json]`.
- `tools/session-retro.mjs`: `suggestSessions(dir, {days, limit}) -> [{repeat, sessions, totalSessions, rule}]`;
  `formatSuggestReport(result)`; CLI `suggest`.

## Владение зонами (disjoint)
- delete-guard: `agent/extensions/nullform-delete-guard.ts` + `tools/install-harness.mjs` (доставка) + `tools/tests/delete-guard.test.mjs`.
- budget: `tools/workflow.mjs` (status/check-budget) + `tools/tests/workflow-budget.test.mjs`.
- suggest: `tools/session-retro.mjs` + `tools/tests/session-retro.test.mjs` (расширение).
- Один владелец на файл; пересечений нет.

## Контракты
- RULES портируются 1:1 из `register.ts` (6 regex), `rmTargets` — подсчёт через `find`/`du` с try/catch fallback.
- Порог budget: 80% от soft budget (200K токенов / 45 вызовов) — константы `BUDGET_WARN_*` в workflow.mjs.
- check-budget ищет HANDOFF-файл: `.workflow/handoff.md` с секциями РЕШЕНИЯ/ТУПИКИ/ДАЛЬШЕ, свежее начала задачи.
- suggest агрегирует `lastCommandCounts`, `errorSamples`, повторы `repeat-xN` по сессиям; правило = однострочный шаблон.
