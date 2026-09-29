# Requirements — публичный релиз NULLFORM WORKFLOW

Source request, verbatim:

> «Сделай его публичным, но переименуй в NULLFORM WORKFLOW, сделай понятное описание в readme, сделай его красивыми и минималистичным. И убери все сенсетив данные и почисти репозиторий от ненужных файлов»

Wave 0 (widget): история git — только HEAD без переписывания; PR #6 вмержен в master перед релизом (done, `672f86f`); README двуязычный EN + RU.

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «убери все сенсетив данные» | В треке нет секретов, токенов, приватных URL, личных email и машинных путей; `backups/*.db` (пустой SQLite, попал в PR #6) удалён из трека; `secrets.example.env` содержит только пустые ключи. | in-spec |
| R02 | «почисти репозиторий от ненужных файлов» | Удалены подтверждённый мусор; changes/history openspec остаются (этоAudit trail); крупные бинарные ассеты skills остаются только если используются; `backups/` вне трека. | in-spec |
| R03 | «переименуй в NULLFORM WORKFLOW» | README, install-адаптеры и видимые пользователю строки говорят NULLFORM WORKFLOW; старый slug `omp-paseo-nullform-workflow` остаётся только как git remote до rename на GitHub. | in-spec |
| R04 | «сделай понятное описание в readme, сделай его красивыми и минималистичным» | README EN+RU: что это, установка за 3 шага, T0–T3 за 30 секунд, ссылка на детали; без 500-строчной простыни. | in-spec |
| R05 | «Сделай его публичным» | Репозиторий `wdnameless/omp-paseo-nullform-workflow` переведён в public (при необходимости с новым именем); CI получает безлимитные минуты, бейдж в README. | in-spec |
