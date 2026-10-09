# session-safety-nets — proposal

## Why
Разбор Claude Code модов (NickVels) + видео s41dv8u3Fno показал 4 переносимых механизма
безопасности сессий, которых нет в нашем воркфлоу: подтверждение необратимых команд,
видимость лимитов, принудительный HANDOFF, правила из повторов сессий.

## What changes
1. **R01 delete-guard**: новое OMP-расширение `agent/extensions/nullform-delete-guard.ts`,
   перехват `tool_call` для bash/eval, `ctx.ui.confirm()` на 6 классах опасных команд.
2. **R02 budget-warning**: `workflow status` показывает предупреждение при ≥80% soft budget.
3. **R03 check-budget**: новая команда-гейт, требует `.workflow/handoff.md` при превышении.
4. **R04 retro-suggest**: `session-retro suggest` — топ-5 повторов + готовые строки правил.

## Non-goals
UI-панели терминала, session-hub/threads моды, LLM-генерация правил.
