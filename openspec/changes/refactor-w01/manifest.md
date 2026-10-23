# Refactor waves 0+1 — requirements

User ask (verbatim): "делай" (волны 0+1 из REFACTOR-PLAN.md) +
"Я хочу красивый, рабочий код и удалить весь мусор".

| ID | Verbatim user quote | Observable acceptance | Status |
|---|---|---|---|
| R01 | «удалить весь мусор» — мёртвый скилл | skills/biblicism-extractor удалён целиком; skills-doctor не репортит его; полный сьют зелёный. | open |
| R02 | «удалить весь мусор» — битые имена | Директории переименованы под declared name (frontend-design, industrial-brutalist-ui); skills-doctor names-clean; ссылки обновлены. | open |
| R03 | «удалить весь мусор» — мёртвые экспорты | Снят export с мёртвых функций (benchmark 22, oracle-model дубликат+6, usage-audit фасад, return-contract дубликат); тесты адаптированы; сьют зелёный. | open |
| R04 | «удалить весь мусор» — worktrees | Снесены 15 worktrees смёрженных веток (0 dirty, MERGED в HEAD); грязные не тронуты; `git worktree list` чист. | open |
| R05 | «красивый, рабочий код» — code-size сканер | maskJsCode: push/pop вместо перезаписи tplStack[top], без фальшивых скобок; фантом esc() исчезает из scan; `code-size:allow` с esc снят; check PASS. | open |
| R06 | «красивый, рабочий код» — quality-evidence | Live-ledger дрейф env-файла даёт WARN/skip вместо FAIL; тест зелёный при 35 settled; исторический снапшот по-прежнему валидируется. | open |

Scope: волны 0+1. Out of scope: сплиты монолитов (волны 2–4), архив openspec-changes (нужно решение пользователя), чужие грязные worktrees.
