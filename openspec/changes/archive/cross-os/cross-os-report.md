# Отчет аудита кросс-платформенности (Linux / macOS)

## 1. [P0] Установка на Linux/macOS: неполная установка harness (Пункт 3)
- **Статус**: Сломается
- **Доказательство**:
  - В tools/install-harness.mjs:287 paseo отсутствует в coreDirs (в install.ps1:217 копируется).
  - Для harness omp (install-harness.mjs:357-368) создаются только AGENTS.md и .harness-root. Не создается симлинк/копия в ~/.omp/agent/agents (в install.ps1:348-360 вызывается Windows-only New-Item -ItemType Junction и [System.IO.Directory]::Delete).
  - Скиллы не копируются в ~/.agents/skills (только в targetRoot/skills). Правила не копируются в ~/.agents/rules.
- **Влияние**: Запуск install.sh на Linux/macOS оставляет harness без ролей агентов, скиллов и правил. OMP не может запуститься в полной конфигурации.
- **Минимальная правка**: Добавить paseo в coreDirs; при установке omp создавать symlink ~/.omp/agent/agents -> targetRoot/agent/agents, линковать/копировать ~/.agents/skills и ~/.agents/rules.

## 2. [P0] Гейты верификации и аудита: отсутствие POSIX-раннеров (Пункт 4)
- **Статус**: Сломается
- **Доказательство**:
  - verify.ps1 (29 проверок) и tools/audit.ps1 (14 проверок) не имеют bash/node эквивалента.
  - Из 29 проверок verify.ps1: 27 проверок переносимы (16 вызывают Node CLI, 11 проверяют файлы/JSON/YAML). 2 проверки содержат Windows-специфику: проверка 14 вызывает cmd.exe /c "" models find  с $env:APPDATA\npm\omp.cmd (на Linux - exit 127); проверка 25 вызывает powershell sync.ps1.
  - Из 14 проверок audit.ps1: 13 переносимы (Node CLI/файлы), 1 Windows-специфична (powershell sync.ps1).
- **Влияние**: На Linux/macOS без PowerShell Core (pwsh) теряются все 29 проверок верификации и 14 проверок аудита. При наличии pwsh проверка провайдера падает из-за cmd.exe.
- **Минимальная правка**: Реализовать verify.sh (или verify.mjs) и audit.sh, вызывающие Node-утилиты напрямую. В проверке провайдера вызывать omp без cmd.exe.

## 3. [P0] Тесты: жесткая привязка к powershell.exe (Пункт 6)
- **Статус**: Сломается
- **Доказательство**: tests/test-portability.ps1 (8 вызовов powershell.exe) и tests/test-sync-guard.ps1 (3 вызова powershell.exe) жестко завязаны на Windows powershell.exe. На Linux/macOS бинарник powershell.exe отсутствует.
- **Влияние**: Интеграционные тесты переносимости невозможно запустить на Linux/macOS в CI.
- **Минимальная правка**: Добавить кросс-платформенные тесты на Node.js (node --test) либо поддержать запуск через pwsh / powershell.

## 4. [P1] Синтаксис и переводы строк в скриптах (Пункт 1)
- **Статус**: Сломается (частично исправлено в ветке)
- **Доказательство**: Файлы skills/agent-browser/templates/*.sh и skills/gitlab-cli-skills/scripts/*.sh имели окончания строк CRLF. На Linux это вызывает /usr/bin/env: 'bash\r': No such file or directory.
- **Влияние**: Сбои выполнения shell-скриптов при запуске агентами на POSIX.
- **Минимальная правка**: Зафиксировать *.sh text eol=lf в .gitattributes, нормализовать существующие файлы в LF.

## 5. [P1] Пути и синхронизация: Windows-слэши в манифестах (Пункт 1, 4)
- **Статус**: Сломается
- **Доказательство**: В tools/sync.ps1:62 массив  содержит 50 путей с обратным слэшем ('agent\AGENTS.md', 'tools\codemap.mjs'). В PowerShell на Linux Join-Path  'agent\AGENTS.md' ищет файл с literal обратным слэшем в имени, а не директорию agent.
- **Влияние**: sync.ps1 на Linux (pwsh) не находит файлы и рапортует ложный 100% дрифт.
- **Минимальная правка**: Заменить обратные слэши на прямые / в  в sync.ps1, либо добавить нормализацию .Replace('\', '/').

## 6. [P2] Файловая система и права исполнения (Пункт 5, 6)
- **Статус**: Под вопросом
- **Доказательство**:
  - Все 22 утилиты tools/*.mjs имеют шебанг #!/usr/bin/env node, но git-режим 100644 (нет флага +x). Прямой вызов ./tools/workflow.mjs на Linux дает Permission denied.
  - В tools/tests/install-harness.test.mjs:275 изоляция PATH через dirname(bashBin) на Linux оставляет доступ к /usr/bin/node, из-за чего негативный тест на отсутствие node может падать.
- **Влияние**: Скрипты tools/*.mjs нельзя запускать как самостоятельные исполняемые файлы без явного node. Тест install.sh может быть нестабилен на Linux.
- **Минимальная правка**: Задать git update-index --chmod=+x tools/*.mjs; в тесте изолировать PATH фиктивным каталогом без node.

## 7. [OK] Node-инструменты: переносимость рантайма (Пункт 2)
- **Статус**: Работает
- **Доказательство**: Все 22 набора тестов в tools/tests/ и test_session_cost.py проходят. Пути склеиваются через node:path (join, resolve), домашний каталог через os.homedir(). В doctor.mjs и auto-review.mjs используется process.platform === 'win32'. test-lens.mjs корректно нормализует слэши и квотирует аргументы для cmd vs sh. dashboard.mjs поддерживает win32, darwin (open) и xdg-open.
- **Влияние**: Ядро инструментов Node.js переносимо между платформами без изменений.
