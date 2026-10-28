# Manifest — universal slices + wizard + integration prompt

Source: user "Что можно взять из этих репозиториев для улучшения? И проверь
чтобы наш воркфлоу был универсальным для разных агентских систем и харнессов
по типу Codex, CloudeCode, Hermes, Openhuman и тд. А еще все эти гейты, литеры
и тд которые мы делаем они должны быть как правила в разработке, верно? Они не
только для нашего воркфлоу репозитория. Я хочу чтобы в репозитории была
инструкция и промпт для ИИ. Который юзер давал своему агенту, агент бы проверял
что сейчас есть у юзера и как уровень интеграции нашего воркфлоу нужно делать.
Для этого давай наш воркфлоу разделим на слайсы и чистую архитектуру, так же
при установке должен открываться cli пункты установки чтобы если юзер захотел
установить все вручную мы бы его вели по выборам по аналогии с openclaw
(как сделано у них)" + repos msitarzewski/agency-agents, paperclipai/paperclip
(2026-10-28).

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Лучшее из agency-agents и paperclip перенесено (матрица харнессов, wizard-паттерн, NEXUS-эскалация, Reality Checker) | "Что можно взять из этих репозиториев для улучшения?" | in-spec |
| R02 | Воркфлоу универсален: Codex/Claude/Hermes/OpenHuman и др. ставятся и работают, матрица детекта декларативна | "универсальным для разных агентских систем и харнессов" | in-spec |
| R03 | Гейты/линтеры — правила разработки для любого проекта, а не только нашего репо (параметризация + доки) | "они должны быть как правила в разработке, верно? Они не только для нашего воркфлоу репозитория" | in-spec |
| R04 | В репо инструкция + промпт для ИИ: агент аудитит сетап юзера и выбирает уровень интеграции L0..L3 | "инструкция и промпт для ИИ ... агент бы проверял что сейчас есть у юзера и как уровень интеграции" | in-spec |
| R05 | Воркфлоу разделён на слайсы чистой архитектуры (S0..S4) с явными зависимостями | "разделим на слайсы и чистую архитектуру" | in-spec |
| R06 | Install открывает CLI-пункты выбора (guided wizard по аналогии с openclaw), ручная установка ведёт по выборам | "должен открываться cli пункты установки ... вели по выборам по аналогии с openclaw" | in-spec |

## Constraints (recon facts)

- C1: init уже интерактивен (bin/nullform.mjs promptHarnessMenu+promptConfirmPlan,
  readline) — wizard расширяет, не переписывает; clack отсутствует в deps.
- C2: quality.mjs — единственный reusable гейт; mutation/coverage захардкожены
  (ROOT, tools/tests); clone без .clone.json loader; code-size без CLI.
- C3: OpenHuman runtime unverified (AGENTS.md inert); Hermes windows wrappers
  скипаются; install.ps1 OMP-only.
- C4: Все внешние источники MIT (attribution в NOTICE/комментах).
- C5: Опыт (general.md, Windows bash paths): «single-quote + forward slashes» —
  применено во всех bash вызовах ченджа.
- C6: openspec validate требует proposal.md + tasks.md + непустой specs/.

## Acceptance (observable)

- A1: tools/harness-matrix.json существует; init меню строится из него (8+custom);
  reviewer знает 3-retry escalation; oracle знает NEEDS-WORK-by-default.
- A2: `nullform init --dry-run` работает для codex/claude/hermes/openhuman без
  OMP-путей в плане; доки называют 4 харнесса supported.
- A3: mutation/coverage принимают --root/--suites и гейтят чужой фикстурный
  проект; clone читает .clone.json; code-size в nullform CLI; docs/GATES.md.
- A4: docs/AGENT-INTEGRATION.md + prompts/integration.md существуют; промпт
  ведёт агента: аудит → L0..L3 → план; L-уровни определены.
- A5: docs/SLICES.md описывает S0..S4 + зависимости + L0..L3 маппинг.
- A6: `nullform init` без флагов ведёт по шагам (flow→harness→slices→dry-run→
  confirm) с бэком и non-TTY фолбэком; шаги покрыты тестами на фикстурах.
