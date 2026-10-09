# Tasks

- [x] R01: Correct requesting-code-review role dispatch and participating workflow/role instructions.
- [x] R02: Record real native review runs and Stage-B evidence bound to source/manifest.
- [x] R02: Enforce reviewer, frozen-test simplification and appropriate independent oracle counts in local and CI gates.
- [x] R01/R02: Add behavior/security boundary regression checks and operator documentation.
- [x] R01/R02 final acceptance gate: record current-source reviewer/Stage-B/independent oracle receipts in `review-evidence.json`; actual verdicts and raw runtime evidence are maintained in `evidence/acceptance.md`. The workflow must pass check/close without a forced override.

- [x] R02 fix round: same REJECT findings touch shared review gates; re-verify review-execution-integrity receipts after the fix (fresh reviewer required — source changes invalidate current ACCEPT chain).
