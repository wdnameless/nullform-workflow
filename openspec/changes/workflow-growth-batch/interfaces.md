# workflow-growth-batch — interfaces

## T1: metrics tools (owner: @fixer)

- NEW `tools/lead-time.mjs`: читает `<root>/.workflow/events.jsonl`
  (строки `{at, kind, text}`), извлекает тир из text (`T0..T3 — task`),
  считает медианы: start→close (по тиру), ask→answered (все паузы),
  artifact-oracle→close. CLI: `--root . [--json] [--help]`. Exit 0 всегда
  при валидном журнале; пустой журнал → нули + exit 0. Экспорт
  `computeLeadTime(events)` для тестов (чистая функция).
- NEW `tools/cfr-report.mjs`: `git log --since=<N>d --format=%H|%at|%s`
  в root; conventional `fix(`/`feat(`; fix в 48ч после feat на той же
  ветке-линии = post-merge fix. CLI: `--root . [--since Nd] [--json]`.
  Вывод: rate% + counts + список. Read-only, без гейта. Экспорт
  `computeCfr(commits)` для тестов.
- Тесты: фикстурные, быстрые (<1с), без git-сети (cfr — мокать вывод log
  через injectable reader ИЛИ тест только computeCfr на строках).

## T2: coverage gate (owner: @fixer)

- NEW `tools/coverage-changed.mjs` по образцу mutation-changed.mjs:
  changed *.mjs vs base (переиспользовать resolveBaseRef/getChangedFiles?
  НЕТ — лёгкий импорт из mutation-changed.mjs запрещён (CLI-модуль с
  side-effect main? main под isDirectRun — импорт безопасен, но тащит
  console-стиль; проще скопировать 30 строк gitDiff-хелпера с пометкой
  ponytail:shared-with). Затем `node --test --experimental-test-coverage`
  на подобранных сьютах (findMatchingSuite — та же история: скопировать
  минимум), парсинг текстового отчёта (строки `file | % | ... | uncovered`),
  пересечение uncovered × changed lines. Порог: ≥50% changed lines
  покрыты. CLI: `--base/--head/--files/--threshold/--dry-run` как у
  mutation-changed. Exit 0/1 (--check семантика встроена: всегда гейтит).
- Тест: парсинг покрытия на фикстурном тексте отчёта + changed-lines
  пересечение; полный node --test НЕ запускать в юнит-тесте.
- repo-gate.yml: шаг `Coverage gate` СРАЗУ после `Mutation gate`:
  `run: node tools/coverage-changed.mjs` (+ те же env BASE_REF/PUSH_BASE/
  EVENT_NAME). Имена существующих шагов не трогать.

## T3: canon docs (owner: @sonic)

- PORTABLE.md: новый подраздел после Wave 2 (перед Wave 3): `#### Bugfix
  fast-lane (T1-протокол)`: 4 шага (red-capable reproduce → minimal fix →
  regression test → oracle-lite), запрет enrich/design/QA-plan/OpenSpec,
  ссылка на CONTEXT red-capable loop. ≤10 строк.
- PORTABLE.md Wave 1.5: +строка: Constraints ДОЛЖНЫ цитировать ≥1 строку
  `.workflow/experience/<domain>.md` или «опыта нет (первый чендж домена)».
- PORTABLE.md §9: +пункт 4 «Артефакт — факт» (Березницкий): инструкция —
  намерение, проверяется только артефакт; + «бутылочное горлышко —
  подтверждение» со ссылкой на lead-time. ≤8 строк.
- orchestrator.md lane defs: T1 +фраза «bugfix идёт fast-lane (PORTABLE)».
  Ничего больше.

## T4: ADR seed (owner: @sonic)

- NEW `docs/adr/0001-mutation-lines-scope.md`: статус accepted; контекст
  (первые-N-мутантов давали произвольный вердикт); решение (--lines на
  changed lines); последствия (CI зависит; необратимо без потери гейта).
  ≤30 строк, формат: Status/Context/Decision/Consequences.
- CONTEXT.md:124: заменить «(No `docs/adr/` exists yet...)» на «(See
  `docs/adr/`; seeded 0001.)». Одна строка.
