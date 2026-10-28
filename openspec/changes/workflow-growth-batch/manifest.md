# Manifest — workflow growth batch (6 советов + видео-канон + целостность)

Source: user "Делай все это и я хочу чтобы наш воркфлоу опирался на
правила из этого ролика. Проверь целостность и что все работает
корректно. Так же опиши мне как сейчас работает наш воркфлоу" (2026-10-28).

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Стоимость проверки измеряется: lead time ревью по тирам из events.jsonl | "Делай все это" | in-spec |
| R02 | Lean-пайплайн багфикса отделён от фичи (reproduce→fix→regression→oracle) | "Делай все это" | in-spec |
| R03 | Coverage-гейт на changed lines в CI (native покрытие, порог 50%) | "Делай все это" | in-spec |
| R04 | docs/adr/ заведён с примером; CONTEXT фиксирует наличие | "Делай все это" | in-spec |
| R05 | CFR-отчёт харнеса: post-merge fix rate по git log за неделю | "Делай все это" | in-spec |
| R06 | Wave 1 цитирует строку опыта в Constraints (цикл замкнут) | "Делай все это" | in-spec |
| R07 | Видео-принципы в каноне: «артефакт — факт», бутылочное горлышко — подтверждение | "опирался на правила из этого ролика" | in-spec |
| R08 | Целостность: живой синк полон, дашборд стартует, все гейты зелёные | "Проверь целостность и что все работает корректно" | in-spec |
| R09 | Описание текущего воркфлоу выдано пользователю | "опиши мне как сейчас работает наш воркфлоу" | in-spec |

## Constraints (recon facts)

- C1: logEvent приватна (workflow.mjs:691); новые события не нужны — lead-time
  выводится из существующих (start/artifact/ask/answered/close).
- C2: Node 24.17 native --experimental-test-coverage работает (проверено).
- C3: .out-of-scope релевантных отказов не содержит.
- C4: R08b уже закрыт в Wave 1: +10 записей манифеста, тест замыкания 3/3,
  живой start→dashboard http 200.
- C5: Тиры = размер работы; bugfix-lane = тип работы внутри T1, не новый тир.
- C6: openspec validate требует proposal.md + tasks.md + непустой specs/.
- Опыт (general.md, 2026-10-27): «Hindsight down → one recall attempt, then local
  context + explicit unavailable note» — применено: recall 1 попытка, дальше локально.

## Acceptance (observable)

- A1: `node tools/lead-time.mjs --root .` считает медиану start→close по тирам
  из .workflow/events.jsonl (+тест на фикстуре).
- A2: PORTABLE содержит раздел Bugfix fast-lane; багфикс идёт без enrich/design/QA-plan.
- A3: `node tools/coverage-changed.mjs --base HEAD~1` гейтит changed lines ≥50%;
  шаг `Coverage gate` в repo-gate.yml; зелёный на текущем дереве.
- A4: docs/adr/0001-*.md существует; CONTEXT.md:124 обновлён.
- A5: `node tools/cfr-report.mjs --since 7d` выдаёт rate + список фиксов.
- A6: PORTABLE Wave 1.5 требует цитату опыта в Constraints; manifest ченджа её содержит.
- A7: PORTABLE §9 содержит принцип «артефакт — факт» + следствие для гейтов.
- A8: живой `workflow start` → dashboard http 200; code-size/clone/eslint/quality/mutation/coverage зелёные.
- A9: ответ пользователю содержит описание воркфлоу (архитектура, волны, гейты, роли).
