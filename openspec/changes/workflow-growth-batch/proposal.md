# workflow-growth-batch — proposal

## Why
Прошлый чендж внедрил 7 правил видео; остались 6 советов роста + опора
канона на видео-принципы + живой синк (R08b закрыт в Wave 1: workflow-замыкание
досинкано, дашборд стартует). Пользователь: "Делай все это", воркфлоу
должен опираться на правила ролика, целостность проверена.

## What Changes
- **Lead-time (R01)**: новый `tools/lead-time.mjs` — медианы start→close и
  ask→answered по тирам из `.workflow/events.jsonl` (+ архив `.workflow/history/`?
  нет — только живой журнал; история позже). Новых событий не пишет.
- **Bugfix fast-lane (R02)**: раздел в PORTABLE + orchestrator lane defs:
  T1-протокол reproduce (red-capable) → minimal fix → regression test →
  oracle-lite; без enrich/design/QA-plan/OpenSpec.
- **Coverage gate (R03)**: новый `tools/coverage-changed.mjs` (образец —
  mutation-changed.mjs): native `--experimental-test-coverage` → changed
  lines ≥50% → fail; шаг `Coverage gate` в repo-gate.yml после Mutation.
- **ADR (R04)**: `docs/adr/0001-mutation-lines-scope.md` (пример: --lines);
  CONTEXT.md:124 обновляется с «нет» на «есть».
- **CFR report (R05)**: новый `tools/cfr-report.mjs` — post-merge fix rate
  за N дней по git log (fix( в 48ч после feat(); read-only отчёт.
- **Experience loop (R06)**: PORTABLE Wave 1.5 — Constraints манифеста
  ДОЛЖНЫ цитировать ≥1 строку `.workflow/experience/<domain>.md` или
  фиксировать «опыта нет».
- **Video canon (R07)**: PORTABLE §9 пункт 4: «Инструкция — намерение,
  артефакт — факт» + следствия (гейты проверяют факт; доверие инструкциям
  запрещено) + «бутылочное горлышко — подтверждение» (ссылка на lead-time).
- **R08/R09**: integrity-sweep родителя + описание воркфлоу в финальном ответе.

## QA-план
Контракты: (1) `openspec validate workflow-growth-batch --strict` exit 0;
(2) три новых CLI имеют --help и exit-коды 0/1/2; (3) существующие гейты
зелёные. Чёрный ящик: свежий клон → `node tools/lead-time.mjs`,
`cfr-report.mjs`, `coverage-changed.mjs --base HEAD~1` дают осмысленный
вывод без падений. Меняется в тестах: +фикстурные тесты lead-time и
cfr-report; coverage-changed — тест парсинга отчёта покрытия на фикстуре
(без полного прогона сьюта). QA-check: сверить команды CI с документом.

## Non-Goals
- CRAP-метрика (следующий шаг после покрытия, не этот чендж).
- CFR как блокирующий гейт (только отчёт).
- История events.jsonl за прошлые задачи (lead-time читает живой журнал).
- Новые тиры (bugfix — лейн внутри T1).
