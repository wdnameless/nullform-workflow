# release-130 — proposal

## Why
Python-стек quality-гейта не исполнялся: `pylint` отсутствовал, и гейт честно
показывал `unverified` вместо `pass`. Одновременно релиз 1.3.0 существует только
в git: в npm опубликована 1.2.0. Нужен pylint в проектном venv и подготовленный,
сертифицированный tarball для публикации.

## What Changes
- Проектный `.venv` с `pylint==4.1.3` и `pylint-cognitive-complexity==0.1.1`;
  `quality check` исполняет python-стек.
- `.venv/` в `.gitignore`, чтобы локальный инструментарий не попадал в
  репозиторий и npm-архив.
- Пересборка tarball из текущего HEAD; сертификация сверяет хэши архива и репо.

## Non-Goals
- Обход `publish-release` гейтов (сертификат, oracle, auth) — запрещён.
- Хранение npm-токена в репозитории или в промптах.
- Повышение версии: 1.3.0 уже зафиксирована в VERSION и package.json.

## QA plan
`quality install` в venv → `quality check` (node+python pass) → `npm pack` →
`certify-package` → публикация владельцем → `npm view` подтверждает 1.3.0.
