# Manifest: multi-harness

Программа: мультихарнес-адаптеры + README-промпт с детектом + уведомление-и-команда самообновления.
Wave 0 закрыта одним раундом виджета. Факты Wave 1: `recon.md` + отчёты агентов
(`agent://SlimRepoProbe/report`, `agent://HarnessFormatsProbe/report`, `agent://InstallSeamProbe/report`).

| ID | Verbatim user quote | Requirement | Status |
|---|---|---|---|
| R02 | «наш воркфлоу поддерживал не только кодинг харнессы, а еще openclaw, hermes, openhumans» | Адаптеры установки для openclaw + hermes (NousResearch) + tinyhumansai/openhuman в install-harness.mjs: skills/agents/rules/mcp пути и форматы по таблице HarnessFormatsProbe; detect + help + тесты по канон-паттерну | done |
| R03 | «в readme был промпт где ты его даешь ии агенту или он сам его находит, дедектит какой у тебя харнесс и предлагает для какой программы нам его поставить» | README-секция с copy-paste промптом: агент детектит харнес (detectHarness), показывает таблицу и ставит выбранный; набор skills/plugins/методологий меняется от харнеса через адаптер | done |
| R04 | «наш харнесс самообновлялся у всех, когда на гитхабе выходят обновления» | Режим «уведомление + одна команда» (Wave 0): версионирование релизов (тег/кхан/manual VERSION — решение в спеках), `check` показывает drift от GitHub-релиза, `update` — одна идемпотентная команда; major-гейт и бэкап локальных правок | done |
| R05i | (implicit, интервью) «tinyhumansai/openhuman» | Цель openhuman = tinyhumansai/openhuman; snowsadh/OpenHumans Foundation — вне скоупа как не-харнесы | in-spec |
| R06i | (implicit, интервью) «Уведомление + одна команда» | Тихое автообновление НЕ делаем; только notify + explicit update (безопасность локальных правок) | in-spec |
| R07i | (implicit, интервью) «Адаптеры → обновление» | Порядок слайсов: сначала адаптеры+R03, затем версионирование+R04 | in-spec |

## Границы (не входит)
- Slim-заимствования 1–5 (self-update staged-транзакция, host-adapter shim, cache-safe-injection, router head, loop-guard) — отдельная следующая программа, не этот заход.
- snowsadh/openhumans, OpenHumans Foundation — не харнесы.
- Тихое фоновое автообновление без ведома пользователя.
