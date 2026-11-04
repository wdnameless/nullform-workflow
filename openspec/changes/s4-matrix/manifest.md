# Manifest — proof-matrix (s4-matrix)

Source: refactor-program (manifest R03+R04+R05 verbatim)
User quotes: "доказуемо на разных системах и харнессах и агентах и ии моделях" (2026-11-04)

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R03 | Доказуемо на разных системах: CI win/mac test-cells + Node 18/20 | "доказуемо на разных системах" | done |
| R04 | Доказуемо на харнессах: verify claude/codex/opencode + install smoke | "на разных ... харнессах" | done |
| R05 | Доказуемо на агентах/моделях: категории × роли, тарифы, evals | "агентах и ии моделях" | done |

## Constraints

- C1: Только expand-contract; ноль изменения существующего поведения.
- C2: Бюджет программы $50: admission policy + spend ledger, spend слайса $0.00.
- C3: Зона слайса S4: repo-gate.yml, tools/verify*.mjs, tools/bench-budget.mjs, tools/model-router.mjs, bench/tasks.json (append-only).
- C4: Матрица стандарт: windows/macos × Node 18/20/22/24; Claude/Codex/OpenCode в verify (остальные 5 харнессов OUT).

## Acceptance (observable)

- A1: repo-gate.yml валиден (YAML sound); содержит win/mac test-cells (tests+lint) и Node 18/20 в матрице; содержит install smoke job (install + verify в чистой VM).
- A2: `verify.mjs` поддерживает `--harness claude|codex|opencode` с динамическим разрешением hostHome/agentDir вместо хардкода OMP; остальные 5 харнессов (omp, cursor, hermes, openclaw, openhuman) отклоняются с явной ошибкой.
- A3: `bench-budget.mjs` реализует тарифы strict/builder/scout × роли (oracle, reviewer, orchestrator, fixer, designer, explorer, scout, sonic, librarian), admission policy и ledger с потолком $50.
- A4: `bench/tasks.json` содержит append-only matrix-кейсы; валидация схемы `validate-tasks` проходит успешно.
- A5: Blind oracle слайса выносит вердикт ACCEPT против мини-манифеста R03–R05.
