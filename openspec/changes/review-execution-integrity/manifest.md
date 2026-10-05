# Accepted requirements: review and skill improvements

## Source and authority

The user replied **"Приступай"** to the immediately preceding four-item recommendation. That reply authorizes implementation of those items, including the explicitly described reviewer/oracle instruction correction; it does not authorize unrelated prompt rewrites. The accepted proposal text below is assistant-authored context, not falsely attributed user speech. The only unresolved decision was fresh evaluation API spending; the user selected **"До $1"** in the structured widget.

| ID | Verbatim user quote | Accepted proposal / observable requirement | Status |
|---|---|---|---|
| R01 | "Приступай" | "Развести reviewer и oracle в инструкциях." Implementation review uses reviewer with diff/context; blind oracle uses original manifest and running product, not implementation plans. Update contradictory requesting-code-review instructions and participating role/workflow instructions. | in-spec |
| R02 | "Приступай" | "Проверять факт выполнения приёмки, не только файл с ACCEPT." Recorded real executions identify role, effective model, independent session, reviewed code and manifest, nonzero model usage, verdict and evidence. T2/T3 gates require reviewer and simplification evidence plus adequate oracle passes, reject stale/mismatched/duplicate/fabricated-empty records. Existing ACCEPT markdown alone is insufficient. | in-spec |
| R03 | "Приступай" | "Добавить структурный аудит навыков в существующий prompt-lint." Audit body length separately from discovery metadata, direct local references and navigation of long reference files. Start with the four identified oversized skills; preserve their semantics while splitting reference material. Report description selection risks, including JEV's first-500-character criteria. | in-spec |
| R04 | "Приступай" | "Измерить пользу ключевых навыков на реальных задачах." Use existing benchmark baseline/candidate infrastructure for fresh isolated review/workflow skill comparisons. Include positive activation, similar negative activation and actual task outcome; record missed defects, false positives/requirement satisfaction, duration and actual spend. Retain unfavorable results; do not claim benefit from wiring checks or fabricated outputs. | in-spec |
| R05 | "До $1" | Fresh comparative evaluation external API spending must not exceed one additional USD; use configured economical models with explicit accounting, bounded generation and stop-on-unknown-spend. Do not request, publish or store credentials. | in-spec |

## Existing constraints, not additional user features

- No new external dependencies, second audit CLI, model routing, automatic modification of arbitrary prompt surfaces, or unrelated changes to auto-review type/lint semantics.
- User-owned untracked CODEMAP.md files and the prior video transcript are preserved and not swept into commits.
- Reuse stdlib and existing benchmark/prompt/workflow commands. A deep validation module is acceptable only to keep existing oversized entrypoints from growing and to centralize trust-boundary checks.
- Evidence is auditable native-execution provenance, not cryptographic proof against a malicious machine owner fabricating all local files.
- Production/live installation is not assumed: source changes must be verified before any deployment.

## Traceability

R01/R02 -> review-execution-integrity. R03 -> skill-structure-audit. R04/R05 -> skill-benefit-evaluation. Final acceptance is against this manifest and observed execution, never the implementation specs.
