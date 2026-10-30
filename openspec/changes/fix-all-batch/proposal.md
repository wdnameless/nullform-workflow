# fix-all-batch — proposal

## Why
T1-аудит (`.tmp/recon-defects-improvements.md`) нашел 2 красных и 5 дыр с
живыми измерениями: CI red на HEAD (COCO python 127>105, 35>23 + certify
win-24), toolAvailable слеп к Windows-venv python (та же асимметрия, что
спрятала M1), efforts без сверки с OMP-схемой, ledger 1.58MB блокирует все
review-run, claims ceiling без пинящего теста. Пользователь: "Чини все по
порядку". Wave 0: M1 = split-then-reseed; C1/C2 = тикетами, не кодом.

## What Changes
- **M1 (R01)**: сплит `tools/session_cost.py` (parse_and_aggregate,
  format_table) до ≤ baseline; остаток — ресид baseline с датой+причиной.
- **M2+S5 (R02, parent)**: rerun win-24 + рабочий способ добычи CI-логов
  (зафиксировать команду) + фикс причины падения.
- **S1 (R03)**: `toolAvailable` пробует `.exe`/`.cmd`/`.bat` и `where` для
  path-like без расширения; python-стек проверяем на Windows-venv.
- **S2 (R04)**: efforts сверены с OMP-схемой (источник назван) — фикс или
  возврат блока в коммент.
- **S3 (R05)**: компактификация review ledger ниже 1MiB (механизм в
  budget.mjs или one-shot архив с тестом); review-run разблокирован.
- **S4 (R06)**: тест nested-workspace → null base в task-claim.test.mjs.
- **C1+C2 (R07+R08, parent)**: 2 GitHub-тикета с замером и планом.

## QA-план
Контракты: (1) `openspec validate fix-all-batch --strict` exit 0;
(2) каждый фикс: red-before/green-after (тест или команда);
(3) существующие гейты зелёные (node COCO 231, eslint, size, clone).
Чёрный ящик: Repo Gate зелен полностью; `review-run --dry-run` проходит
admission; QUALITY_PYTHON на venv → python-стек runs.
Меняется в тестах: +pin-тест claims ceiling; +toolAvailable win-venv кейс;
python-тесты session_cost при сплите. QA-check: команды A1–A6 из manifest
дословно воспроизводятся.

## Non-Goals
- Сплит workflow.mjs (C1, потолок не пробит) — только тикет.
- Skills prune/lazy-каталог (C2) — только тикет.
- Переписывание quality.mjs/claims.mjs — точечные фиксы.
- Новые гейты или слайсы — только чинка найденного.
