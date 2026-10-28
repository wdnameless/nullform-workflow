# universal-slices-wizard — proposal

## Why
Пользователь принёс два репо (agency-agents: 230+ персон + tools.json матрица
17 харнессов + NEXUS; paperclip: control plane + evals + clack wizard) и
потребовал: universality для Codex/Claude/Hermes/OpenHuman, гейты как правила
разработки для любого проекта, слайсы чистой архитектуры, guided install
wizard как у openclaw и промпт интеграции для чужого агента. Аудит показал:
8 адаптеров есть, но гейты (кроме quality) не reuse, init — 2 вопроса вместо
wizard, слайсов и промпта нет.

## What Changes
- **Slices (R05)**: `docs/SLICES.md` — S0 core (PORTABLE+lanes+manifest+oracle),
  S1 gates (5 гейтов как библиотека), S2 roles (агенты+NEXUS+Reality Checker),
  S3 install (wizard+matrix), S4 integrate (промпт+L0..L3). Зависимости только
  вниз (S4→S0+S1, S2→S0, S3→S0, S1→S0).
- **Matrix (R01+R02)**: `tools/harness-matrix.json` — декларативные detect/
  paths/scopes для 8+custom (идея agency tools.json, MIT attribution);
  init меню строится из неё; OpenHuman помечен `runtime: unverified`.
- **Gates reuse (R03)**: mutation/coverage принимают `--root/--suites`
  (changed-scope параметризован, дефолты = текущие); clone читает
  `.clone.json` (scope override); `nullform quality` расширен под code-size;
  `docs/GATES.md` — гейты как правила для любого проекта (команды+пороги).
- **Prompt (R04)**: `docs/AGENT-INTEGRATION.md` (инструкция) +
  `prompts/integration.md` (промпт чужому агенту: аудит→L0..L3→план).
- **Wizard (R06)**: init расширен шагами flow(quick/advanced)→harness→
  slices→dry-run→confirm с back (`..`) и non-TTY фолбэком; zero-dep
  (readline, без clack — clack только рекомендация в SLICES для форков).
- **Roles (R01)**: reviewer +1 строка NEXUS 3-retry escalation;
  oracle +1 строка Reality Checker (NEEDS-WORK by default, zero-issue = flag).

## QA-план
Контракты: (1) `openspec validate universal-slices-wizard --strict` exit 0;
(2) все новые CLI --help exit 0; (3) существующие гейты зелёные.
Чёрный ящик: фикстурный чужой проект (без tools/tests) гейтится mutation/
coverage/clone с --root; `nullform init --dry-run --harness codex` не
содержит OMP-путей; wizard шаги прогоняются на piped stdin.
Меняется в тестах: +фикстурные тесты matrix/wizard/gates-reuse; сьюты гейтов
расширены --root кейсами. QA-check: команды GATES.md дословно воспроизводятся.

## Non-Goals
- promptfoo evals, 409 locks, settlement split, token-gated UI (paperclip
  deep cuts — следующий чендж).
- clack-зависимость (zero-dep принцип; clack в рекомендации).
- OpenHuman runtime verify (нужен вендор; помечаем unverified честно).
- install.ps1 мультихарнесс (legacy OMP; путь — nullform init).
- Переписывание init с нуля (расширяем readline-сессию).
