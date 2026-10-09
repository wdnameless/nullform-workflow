# multi-harness — proposal

## Why
Воркфлоу ставится только в кодинг-харнесы (omp/claude/codex/opencode/cursor).
Пользователи openclaw, hermes, openhuman остаются без установки, а обновления
доезжают только ручным `git pull` + reinstall — у каждого своя версия.

## What changes
1. **Адаптеры (слайс A):** openclaw + hermes + tinyhumansai/openhuman в install-harness.mjs
   (skills/agents/rules/mcp по их форматам), авто-детект, README-промпт одной фразой.
2. **Обновление (слайс B):** VERSION + `self-update check/update` + doctor WARN о drift
   от GitHub-релиза + бэкап live-файлов в sync deploy.

## Non-goals
Slim-заимствования (отдельная программа), snowsadh/OpenHumans Foundation,
тихое автообновление без ведома пользователя.
