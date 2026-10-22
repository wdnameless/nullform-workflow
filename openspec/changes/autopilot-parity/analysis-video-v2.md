# Autopilot v2.2.0 vs Nullform — видео-разбор (аддендум к gap-registry)

> Аддендум к `.tmp/autopilot-gap-registry.md` (T3, R01–R12, ACCEPT 2026-10-22).
> Независимая перепроверка по тем же источникам + расшифровка видео SP0iluzau78.
> Вывод: R01–R12 закрывают механизмы; этот файл + R13 (run-view) закрывают
> человеко-читаемый слой дашборда. Дублей SPEC-файлов нет.

Источники перепроверки: клон nick-vels/skills (SKILL.md, 17 phases, prompts,
ap.py 1075 строк, dashboard-template.html 1293 строки, docs, tests, CHANGELOG),
расшифровка видео SP0iluzau78 «ЭТОТ фреймворк делает ВСЁ за тебя» (33 мин),
наш стек (tools/dashboard.mjs, tools/workflow.mjs, agent/AGENTS.md).

## 1. Что такое Autopilot (факты)

Пайплайн из 8 стадий: Подготовка (preflight) → Требования (manifest) →
Брифинг (вопросы) → Спецификация → План (таски) → Разработка (субагенты) →
Код-ревью → Приёмка (blind, G4). Код пишется только на 6-й стадии.
Два регулятора: mode (full/semi-default/interview/manual) и depth
(strict/normal-default/deep). Состояние — `state.js`, пишет только `ap.py`
(19 команд). Дашборд — один HTML с встроенным снапшотом + HTTP на 127.0.0.1,
poll state.js каждые 10 с, живой тик 1 с. Память: AGENTS.md, PROGRESS.md,
carried.md, docs/adr/, CONTEXT.md, git-трейлеры Autopilot-Run/Requirements.
Метрики v2.0 vs v1.x: −28% токенов, оркестратор −46%, ревью −51%, 96 мин vs 145.

## 2. Сравнение по осям (A = Autopilot, N = Nullform)

| Ось | Autopilot | Nullform | Вердикт |
|-----|-----------|----------|---------|
| Стадии SDD | 8 фиксированных, код на 6-й, rule 5 | T0–T3 тиры, lane→recon→manifest→openspec→interfaces→oracle, оркестратор не кодит на T2+ | Паритет по духу; у нас гибче тиры, у них жёстче порядок |
| Manifest R## verbatim | Да, redaction секретов, статусы, гейты | Да (requirements.mjs), R## + цитаты | ✅ Паритет |
| Briefing-вопросы | Раунды + рекомендации + adversarial pass | Только Wave 0 интервью (grill-me), нет фазового файла | ❌ Пробел: нет phases/2-briefing аналога |
| Adversarial | Отдельная фаза до спеки (7 вопросов на крах) | Чеклист в checklists.mjs, не фаза | ❌ Пробел: нет обязательной фазы |
| Spec | spec.md + notes.md + interfaces.md до 1-го таска | openspec/ change, interfaces.md | ✅ Паритет |
| Plan/нарезка | Тикеты по ~3K строк кода, волны, дизъюнктные зоны, wide change | Тиры по файлам/риску, нет калибровки по объёму | ❌ Пробел: нет size-калибровки |
| Subagent-пул | 1 тикет=1 агент, ≤3 в полёте, return contract ≤25 строк, волны не барьер | task() хоста, контракт ≤25 строк есть, своего раннера нет | ⚠️ Частично: контракт есть, раннера/волн нет |
| Repair | Дозапрос автору vs свежий агент, лимит 2, D## | Нет выделенного протокола | ❌ Пробел |
| Review | Точечное (фундамент+риск, фоном) + ветки F1 в конце | reviewer роль + auto-review.mjs | ⚠️ Частично: нет фонового/точечного протокола |
| Blind acceptance | G4: чистый git clone, спека запрещена промптом, запуск сценария | blind-accept.mjs: изолированный клон + физический purge openspec/tickets/spec/manifest | ✅ Мы строже (purge > запрет) |
| Gates | G1–G4 machine-checkable (ap.py) | check exits 1, oracle ACCEPT/REJECT | ⚠️ Частично: нет G1–G4 ряда |
| Дашборд | hero-цвет, трек 8 стадий, бары тасков по волнам, "твои слова", G1–G4, feed, отчёт, waits вычитаются, тик 1с, снапшот в HTML, same-port resume | 7 вкладок (overview/arch/logs/diffs/critique/debt/history), /api/state+/api/diff+/api/health, poll 3с, i18n | ⚠️ Разные сильные стороны: у нас arch/diffs/debt/history, у них hero/waves/words/gates/feed |
| Resume | 0-resume.md + ap.py commits (rebase/reset detect) | Нет команды resume | ❌ Пробел |
| Memory | PROGRESS.md + carried.md + трейлеры + AGENTS.md-инструкции для plain-сессий | carry.mjs (carried.md, debts.json, skills-lock verify) + handoff.md | ✅ Паритет, у нас +verify хешей |
| Метрики | measure-run.py: нормировка output×5, калибровка 150–450K, cache-rot detect | session_cost.py, metrics, bench-*.mjs | ⚠️ Частично: нет per-role нормировки |
| Secrets | Никогда не просить, redact at ingest, leak = stop (ap.py ask stop) | brief.mjs redact, .env сам, redaction gate | ✅ Паритет |
| Rationalizations | Отдельный файл против самообмана | Нет | ❌ Пробел (малый) |
| Установка | npx skills add, 70+ агентов, skills.sh бейдж | install.ps1/install.sh, verify.* | ⚠️ У нас нет skills.sh-пакета |

## 3. Что забираем (приоритет)

1. Дашборд R04: hero-статус цветом + трек стадий + волны/бары + "твои слова" +
   гейты + лента + waits-вычитание + offline-снапшот. → этот change.
2. Фазы briefing/adversarial как файлы agent/phases/ + гейты G1–G4 в workflow.mjs. → follow-up.
3. Size-калибровка нарезки (~3K строк/агент) + волны/зоны в AGENTS.md. → follow-up.
4. `workflow resume` + commits-проверка. → follow-up.
5. Repair-протокол + rationalizations. → follow-up.
6. skills.sh-упаковка (SKILL.md). → follow-up.

## 4. Где мы уже лучше (держать и доказывать)

- Blind accept с физическим purge (сильнее промпт-запрета).
- Тиры T0–T3 с бюджетами вызовов (у них один размер пайплайна).
- Stage B сжатие, Double acceptance flash, nano-USD бюджет ревью.
- Дашборд: arch-граф, diffs-модалки, debt-реестр, history-метрики.
- skills-lock verify SHA-256, debt-ledger, context-inbox.
- Нужен свой benchmark.md с цифрами: прогнать measure-аналог и зафиксировать.
