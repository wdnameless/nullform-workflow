# Weakness report — ci-green-selfheal (R04)

Дата: 2026-10-24. Метод: `verify.mjs`, `doctor`, `skills-doctor`, `prompt-lint`,
`code-size check`, `workflow check-ci --push`, grep-инвентарь. Каждый пункт —
с file:line или командой-доказательством.

## Критические (ломают CI/поставку)

**W01 — Push-гейт навсегда красный от истории** (`tools/workflow-ci.mjs:193-214`,
`tools/review/evidence.mjs:598`). `checkPushEvidence` валидирует каждый change
диапазона против ТЕКУЩЕГО дерева; `sourceDigest`/`computeRolePromptHash`/
`testFilesHash` берут HEAD. Любой коммит после приёмки инвалидирует архивные
evidence. Доказательство: `node tools/workflow.mjs check-ci --push --base-ref
81c1f1b` → exit 1, 18 changes, «role prompt hash mismatch / Oracle source digest
is stale». Исправляется в T-01.

**W02 — Полный прогон тестов не завершается** (`tools/tests/adaptive-harness-cli.test.mjs`).
`timeout 120 node --test <файл>` → exit 124, вывод 0 байт даже со `--test-reporter=spec`.
Следствие: `node --test tools/tests/*.test.mjs` не укладывается в 1200 с.
Исправляется в T-03.

## Высокие

**W03 — Дрейф установленного харнесса от пакета** (`doctor`: version-alignment WARN).
Бинарник v1.3.0, проверенная установка v1.2.0, «pending/recoverable». Лечится
`nullform heal` (T-05).

**W04 — Ручная установка неавтономна** (`bin/nullform.mjs:396-411`). При >1
кандидате AI-агент получает `ambiguous_harness` и не может продолжить без
человека; подтверждения плана перед записью нет. Лечится `nullform setup` (T-02).

**W05 — Нет самовосстановления**. Есть диагностика (`doctor`) и переустановка из
registry (`update`), но нет локального ремонта повреждённого адаптера/файлов.
Лечится `nullform heal` (T-05).

## Средние

**W06 — 108 мест с проглатыванием ошибок** (`grep -c 'catch {}' tools/*.mjs` = 108,
12+ файлов). Часть законна (best-effort сканеры), но `install-detect.mjs` и
`doctor-checks.mjs` среди них означают, что сбой детекта/диагностики может
выглядеть как «всё хорошо».

**W07 — 19 дефектов реестра навыков** (`node tools/skills-doctor.mjs`): 2
truncation (`quality-engineer` 6284 vs 7384; `requesting-code-review` 5826 vs 6728),
1 duplicate-name (`technical-client-acquisition-and-marketplace-sales` дублирует
`technical-client-acquisition`), 6+ orphan. Ключевое: «A skill that fails to parse
is dropped from the registry SILENTLY» — потеря навыка не видна пользователю.

**W08 — 112 WARN в `prompt-lint skills --check`** (описания >500 символов,
недостижимые references). Скилл-роутинг может терять триггеры за границей 500.

**W09 — code-size: 6 нарушений** (dashboard-ui +291, dashboard +32, doctor.test
+39, workflow-gate.test +51, 2 функции +1). Все предсуществуют; гейт на них
красный, значит новый рост в этих файлах невидим.

## Низкие

**W10 — Дрейф от встроенных агентов OMP** (doctor: `reviewer.md`, `sonic.md`
перекрывают встроенные при first-wins). Осознанный форк, но дрейф не
сигнализируется автоматически.

**W11 — `prompt-baseline` WARN**: дрейф поверхностей промптов от baseline не
объяснён (код 1), т.е. baseline устарел либо правка не отражена.

## Что исправляется в этом change

W01→T-01, W02→T-03, W03/W05→T-05, W04→T-02, R08→T-04. Остальные (W06–W11)
фиксируются здесь как принятый долг с триггерами: W06 — при следующем касании
доктора; W07/W08 — отдельный change `skills-registry-hygiene`; W09 — ребейз
baseline владельцем дашборда; W10/W11 — при следующей правке агентов.
