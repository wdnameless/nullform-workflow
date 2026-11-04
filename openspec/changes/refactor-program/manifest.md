# Manifest — рефакторинг + доказуемое улучшение (refactor-program)

Source: user "Давай, так же давай сделаем рефакторинг и улучшение чтобы у нас
был красивый и поддерживаемый код. И все работало и улучшали разработку
доказуемо на разных системах и харнессах и агентах и ии моделях" (2026-11-04)
+ Wave 0 picks + T3 recon `.tmp/recon-refactor-program.md`.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Красивый поддерживаемый код: хотспоты к потолкам с запасом, stage B | "красивый и поддерживаемый код" | in-spec |
| R02 | Всё работает: ноль поведения, тесты заморожены, гейты зелёные | "все работало" | in-spec |
| R03 | Доказуемо на разных системах: CI win/mac test-cells + Node 18/20 | "доказуемо на разных системах" | in-spec |
| R04 | Доказуемо на харнессах: verify claude/codex/opencode + install smoke | "на разных ... харнессах" | in-spec |
| R05 | Доказуемо на агентах/моделях: категории × роли, тарифы, evals | "агентах и ии моделях" | in-spec |
| R06 | Дельты поведения: lead-time/CFR/bench было→стало на слайсах | "улучшали разработку доказуемо" | in-spec |

## Constraints (Wave 0 + recon facts)

- C1: Слайсами, oracle на каждый (не весь репо разом).
- C2: Только expand-contract; ноль изменения поведения (риск-граница).
- C3: Бюджет $50 на программу: admission policy + spend ledger, без исключений.
- C4: Только код репо: без промпт-поверхностей, npm-релиза, доков сайта.
- C5: Матрица стандарт: +macOS, Claude/Codex/OpenCode (не все харнессы).
- C6: workflow.mjs 2500/2500 — S1 первым, тикет #16 закрывается им.
- C7: Оркестратор на T3 код проекта не пишет; один пишущий на worktree.
- C8: PORTABLE §9: без парных A/B — влияние на качество `not-proven`.
- C9: Prune только с grep-доказательством 0 прод-коллеров (не наугад).

## Product quality contract (PORTABLE §10, применимое)

| Поле | Значение |
|---|---|
| actor/action/outcome | dev → `node tools/quality.mjs check` + `code-size check` + `node --test` → exit 0 с маржой к потолкам |
| workload + environment | репо 292 файла / 2085 функций; CI ubuntu+windows+macos × Node 18/20/22/24 |
| limits | каждый файл ≤ defer/baseline с запасом ≥5%; COCO ≤ baseline; полный сьют < 25 мин |
| command | `node tools/quality.mjs check --root . && node tools/code-size.mjs check --root . && node --test tools/tests/*.test.mjs` |
| required | да (R01+R02); кросс-OS ячейки — да (R03); UI — n/a (CLI-утилита без интерфейса) |
| raw evidence | stdout гейтов + exit codes (снимает S5) |

## Acceptance (observable)

- A1: все файлы слайсов ≤ потолков с запасом ≥5%; Stage B disposition записан.
- A2: поведение бит-в-бит: замороженные тесты зелёные, дифф только move/split.
- A3: CI зелёный на win/mac test-cells + Node 18/20 (не только tarball).
- A4: `verify` покрывает claude/codex/opencode; install smoke job зелёный в CI.
- A5: тарифы категорий × роли в bench-budget; evals прогнаны в пределах $50.
- A6: отчёт S5: lead-time/CFR/bench было→стало + `not-proven` где нет A/B.
