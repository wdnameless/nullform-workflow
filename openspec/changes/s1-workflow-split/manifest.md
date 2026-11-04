# Manifest — s1-workflow-split

Source: user "Давай, так же давай сделаем рефакторинг и улучшение чтобы у нас был красивый и поддерживаемый код. И все работало" (2026-11-04) + program manifest R01+R02.

criticality: supporting

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Красивый поддерживаемый код: хотспоты к потолкам с запасом, stage B | "красивый и поддерживаемый код" | in-spec |
| R02 | Всё работает: ноль поведения, тесты заморожены, гейты зелёные | "все работало" | in-spec |

## Constraints

- C1: Split tools/workflow.mjs (2500 lines) into tools/workflow.mjs, tools/workflow-ci.mjs, tools/workflow-core.mjs.
- C2: Each file < 1200 lines.
- C3: bin/nullform.mjs passthrough byte-identical.
- C4: Zero behavior change; frozen test suite stays green; move only in tests.
- C5: Spend through ledger ($0 model calls for slice S1).
