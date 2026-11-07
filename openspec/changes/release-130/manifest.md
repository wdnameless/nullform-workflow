# Manifest — release-130 (pylint + npm)

Source: user «Давай сделаем pylint и готовь все к релизу и чтобы обновленная
версия была в npm не только в гит» (2026-11-07).

criticality: supporting

## Requirements

| ID | Requirement | Verbatim quote | verify | Status |
|----|-------------|----------------|--------|--------|
| R01 | pylint исполняется в гейте, python-стек не `unverified` | "Давай сделаем pylint" | `node tools/quality.mjs check --root .` → `python pass` | done |
| R02 | Установка анализатора не пишет в системный интерпретатор | "сделаем pylint" (безопасность установки) | `quality install` без venv → `skipped-no-venv` | done |
| R03 | venv не попадает в git и в npm-архив | "только в гит" (разделение артефактов) | `git check-ignore .venv` + разбор tarball | done |
| R04 | Tarball соответствует текущему HEAD | "чтобы обновленная версия была в npm" | `npm pack` + `certify-package` hash-сверка | done |
| R05 | Публикация в npm выполнена и версия видна в registry | "в npm не только в гит" | `npm view nullform-workflow version` → 1.3.0 | open |
| R06 | Релиз не обходит fail-closed гейты (сертификат, oracle, auth) | "готовь все к релизу" | `publish-release` без обхода | in-spec |

## Constraints

- C1: npm-токен не запрашивается и не хранится; `npm login` выполняет владелец.
- C2: `quality install` не ставит пакеты в системный Python.
- C3: сертификация и oracle не подменяются ручным ACCEPT.
- C4: версия 1.3.0 уже в VERSION и package.json; повторный bump не нужен.

## Acceptance

- A1: `quality check` → `node pass`, `python pass`, `COCO ratchet clean`.
- A2: `git status` чист, `.venv` вне индекса.
- A3: `certify-package` проходит на свежем tarball.
- A4: `npm view nullform-workflow version` возвращает 1.3.0 после публикации.
