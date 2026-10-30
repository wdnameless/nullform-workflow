# Manifest — fix-all defects batch (M1→C2)

Source: user "Чини все по порядку" (2026-10-30) on T1 recon
.tmp/recon-defects-improvements.md + Wave 0 widget picks.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | M1: python-COCO зелен — сплит session_cost.py, остаток ресид с причиной | "Чини все по порядку" | in-spec |
| R02 | M2+S5: certify win-24 зелен (rerun+фикс) и добыча CI-логов работает | "Чини все по порядку" | in-spec |
| R03 | S1: toolAvailable видит Windows-venv python (.exe-проба) | "Чини все по порядку" | in-spec |
| R04 | S2: efforts в models.yml.example сверены с OMP-схемой (фикс или возврат в коммент) | "Чини все по порядку" | in-spec |
| R05 | S3: review ledger скомпактирован ниже 1MiB, review-run разблокирован | "Чини все по порядку" | in-spec |
| R06 | S4: семантика claims ceiling запинена тестом nested-workspace → null | "Чини все по порядку" | in-spec |
| R07 | C1: тикет на сплит workflow.mjs с замером и планом (без резки) | "Чини все по порядку" | in-spec |
| R08 | C2: тикет на skills prune/lazy-каталог с замером и планом (без резки) | "Чини все по порядку" | in-spec |

## Constraints (recon facts)

- C1: M1-policy = split-then-reseed (Wave 0); C1/C2 = tickets only (Wave 0).
- C2: Baseline python rows: parse_and_aggregate 105, format_table 23 (656bfea).
- C3: toolAvailable miss: path-like w/o ext → false (quality.mjs:180).
- C4: Ledger 1.58MB vs MAX_LEDGER_BYTES 1MiB (budget.mjs); blocks all review-run.
- C5: Опыт general.md: Hindsight down (1 attempt, local), Windows paths quoted.
- C6: openspec validate требует proposal.md + tasks.md + непустой specs/.
- C7: Оркестратор на T2+ код проекта не пишет — только спеки/манифест/ops-мердж.

## Acceptance (observable)

- A1: pylint python-стек: 0 growth-failures; baseline diff содержит только
  ресид-остаток с датой+причиной либо пуст.
- A2: Repo Gate зелен полностью (incl. win-24 cell); логи CI добываются
  командой из recon (записана рабочая команда или фикс).
- A3: QUALITY_PYTHON на Windows-venv → python-стек runs (не missing-tool).
- A4: models.yml.example efforts == OMP-схеме (источник проверки назван) или
  блок возвращен в коммент.
- A5: ledger < 1MiB; `review-run --dry-run` проходит admission (не ledger-refuse).
- A6: task-claim.test.mjs содержит nested-workspace → null тест, сьют зелен.
- A7/A8: GitHub issues созданы (номера в oracle receipts).
