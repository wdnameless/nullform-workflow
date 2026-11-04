# Manifest — behavior-deltas (s5-deltas)

Source: refactor-program (manifest R06 verbatim)
User quotes: "улучшали разработку доказуемо" (2026-11-04)

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R06 | Дельты поведения: lead-time/CFR/bench было→стало на слайсах | "улучшали разработку доказуемо" | done |

## Constraints

- C1: Только замеры было→стало и отчёт доказательства; ноль продуктового кода.
- C2: PORTABLE §9: без парных A/B влияние на качество = `not-proven` (честно в отчёт).
- C3: Бюджет программы $50: admission policy + spend ledger, spend всей программы $0.00.
- C4: Зона файлов: `bench/runs/refactor-program/*` (new), `docs/benchmark-live.md` (append), `openspec/changes/s5-deltas/*` (new).
- C5: Замеры фиксируются между базой было (`f1864ee`, до слайсов) и стало (`7509028`, S1+S2+S3+S4 в мастере).

## Acceptance (observable)

- A1: Мини-манифест R06 вербатим программного манифеста записан в `openspec/changes/s5-deltas/manifest.md`.
- A2: Замеры было (`f1864ee`) → стало (`7509028`) по 6+ дельтам: code-size (файлы/функции), quality node (violations), COCO топ-нарушителей, lead-time медианы T1/T2, CFR 8d-окна, bench-compare baseline-vs-slice (минимум 2 tasks), gate-counter сводка.
- A3: Каждая дельта содержит сырой вывод команды (raw evidence) или явную отметку `not-proven`.
- A4: Отчёт зафиксирован в `bench/runs/refactor-program/report.md` и `openspec/changes/s5-deltas/report.md`, а также добавлен в `docs/benchmark-live.md`.
- A5: Выписка из spend-ledger подтверждает суммарный расход программы $0.00 ≤ $50.00.
