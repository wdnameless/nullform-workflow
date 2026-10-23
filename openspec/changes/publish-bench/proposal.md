# Publish-bench proposal

## Why
SCORING: установка 5→8 и метрики 6→8 взяты упаковкой, но публикация не
завершена (неверный репо-путь в SKILL.md, нет фаз/зеркал/lock), а benchmark
синтетический (фикстура, не живая сессия). Их benchmark.md — живые цифры
двух прогонов. Для заявки №1 нужны живые цифры наших прогонов.

## What changes
1. **skills-publish** (R01): починить SKILL.md (репо-путь, argument-hint,
   metadata.version, disable-model-invocation), добавить phases/
   (briefing/build/review из наших команд), зеркала .claude/.agents,
   skills-lock.json, README-бейдж + install-инструкция.
2. **live-benchmark** (R02): measure-session.mjs (парсинг session usage +
   journal beats → роли/units/время), замер universal-1 сессии,
   docs/benchmark-live.md со сравнением vs их 29.4M/21.1M и 145/96 мин.

## Non-goals
- GitHub-пуш, skills.sh-регистрация (руками пользователя).
- Параллельный прогон autopilot (сравниваем с их опубликованными цифрами).
