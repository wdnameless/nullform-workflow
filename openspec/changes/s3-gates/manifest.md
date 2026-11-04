# Manifest — gates-coco-prune (s3-gates)

Source: refactor-program (manifest R01+R02 verbatim)
User quotes: "красивый и поддерживаемый код" and "все работало" (2026-11-04)

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Красивый поддерживаемый код: хотспоты к потолкам с запасом, stage B | "красивый и поддерживаемый код" | in-spec |
| R02 | Всё работает: ноль поведения, тесты заморожены, гейты зелёные | "все работало" | in-spec |

## Constraints

- C1: `quality.mjs` (804 строки) → ≤ 700 с запасом (разрез CLI/engine по defer-триггеру).
- C2: `sync.mjs:main` (315 строк) → ≤ 200; `usage-audit.mjs:auditUsage` (208 строк) → ≤ 200 (сплит функций).
- C3: Prune 9 unwired модулей (asset-freeze, blind-accept, capsule, checkpoints, coverage-check, fallback, supervision, two-phase, usage-normalize) с grep-доказательством 0 прод-коллеров; удаление + чистка CODEMAP/индексов; тесты мёртвых модулей удалить вместе.
- C4: Baseline/COCO: только вниз (min-recorded), без ресидов вверх.
- C5: Ноль изменения существующего поведения; expand-contract; замороженные тесты зелёные.
- C6: Бюджет программы $50: spend слайса $0.00.

## Acceptance (observable)

- A1: `tools/quality.mjs` ≤ 700 строк с запасом (файл + engine модуль), defer-триггер снят/обновлен, `node tools/code-size.mjs check` green без нарушений.
- A2: `sync.mjs:main` ≤ 200 строк и `usage-audit.mjs:auditUsage` ≤ 200 строк в проверке `node tools/code-size.mjs check`.
- A3: Все 9 unwired модулей удалены вместе с их тестами; grep доказывает 0 прод-коллеров; CODEMAP и списки файлов очищены от ссылок на удалённые файлы.
- A4: `node tools/quality.mjs check --root . --stack node` и `node tools/code-size.mjs check --root .` проходят успешно (exit 0); COCO только вниз.
- A5: Все тесты слайса проходят успешно без регрессий.
- A6: Blind oracle выносит вердикт ACCEPT против мини-манифеста R01–R02.
