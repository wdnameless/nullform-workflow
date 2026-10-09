# Manifest: session-safety-nets

Источник: «Да, делай» на 4 пункта из разбора модов NickVels + видео s41dv8u3Fno.
Транскрипт: `context/product/video-claude-code-mods.md`. Архив разобран из `temp/nickvels-mods.zip`.

| ID | Verbatim user quote | Requirement | Status |
|---|---|---|---|
| R01 | «Да, делай» | Порт delete-guard в OMP-расширение: необратимые команды (`rm -r`, `git push --force`, `git reset --hard`, `git clean -f`, `find -delete`, `DROP/TRUNCATE`) требуют подтверждения через `ctx.ui.confirm()`; в неинтерактивном режиме — пропуск без блока (как в оригинале). | done |
| R02 | «Да, делай» | Budget-warning в `workflow status`: при приближении к soft budget (порог настраиваемый, дефолт 80% от 200K токенов / 40 вызовов) — видимое предупреждение. Данные из session_cost.py / счётчиков сессии. | done |
| R03 | «Да, делай» | `workflow check-budget` гейт: при превышении порога требует HANDOFF-файл (`РЕШЕНИЯ / ТУПИКИ / ДАЛЬШЕ`) перед продолжением; exit 1 без него. | done |
| R04 | «Да, делай» | `session-retro --suggest` (точнее `suggest` subcommand): топ-5 повторов из сессий с числом сессий + готовые строки правил для протокола. Без LLM — чистая агрегация существующих сигналов scoreSession. | done |
## Границы (не входит)
- session-hub, threads, autopilot-progress моды — чужой рантайм / дубль dashboard.
- UI-панели в терминале (ctx-шкалы) — у нас нет canvas Claude Code; только текстовые варнинги.
- LLM-генерация модов из промпта — только детерминированная агрегация повторов.
