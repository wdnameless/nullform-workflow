# Evidence before automatic skill activation

## ADDED Requirements

### Requirement: Benefit evaluation MUST use independent held-out skill decisions

Evaluation MUST retain separate canonical calibration (at least 12 cases) and held-out RU/EN skill/risk data (at least 40 cases). The pinned baseline chat model selects skill/none from the same native catalog; JEV is the candidate classifier. Report attempted precision, all-case recall, coverage, no-skill false positives, safety/critical misses, actual outbound requests, usage, latency and costs. Quality and decision-cost summaries MUST use held-out rows only; all errors, safety cases and spending include calibration. Valid high-confidence none counts as a decision; low-confidence abstention does not disguise a wrong confident answer. No simulated demonstration is live proof.

#### Scenario: Live paired evaluation
- **WHEN** the run executes within the approved additional $1.00 API ceiling
- **THEN** the v2 report records actual model snapshots, all canonical case IDs, receipt/error fields and costs, and distinguishes scoped API classifier benefit from unproven whole-workflow/subscription savings.

### Requirement: Activation MUST bind complete canonical evidence

Policy/report v2 MUST validate exact raw report hash, native catalog/model identities, current decision snapshots and expiry. Evidence MUST bind exact canonical corpus SHA-256 hashes, IDs, expected labels and canary flags; missing/modified/extra rows cannot qualify. A clean proof MUST be completed with zero errors and zero unknown usage. Skill activation MUST have no safety/critical miss, >=70% attempt coverage, >=95% attempted precision no worse than baseline, and lower actual decision cost or demonstrated quality improvement. Held-out labels/prompts/thresholds MUST NOT be retuned to pass. Historical v1 routing reports MUST NOT activate this release.

#### Scenario: Invalid proof
- **WHEN** an API fails, costs are unknown, canaries are removed, gold/hashes are changed, or evidence is stale/simulated/incomplete/v1
- **THEN** activation is rejected and the original workflow continues.

#### Scenario: Catalog or model changes
- **WHEN** current catalog/model/report identity no longer matches the measured v2 evidence
- **THEN** assistance falls back automatically.

### Requirement: Native skill behavior MUST be exercised end to end

Acceptance MUST observe actual OMP turn suggestion and unchanged stable prefix/models, plus no-key/opt-out/error/privacy paths, not only mocked callbacks. New request shapes MUST have real redacted recording, integrity validation and strict replay.

#### Scenario: Real native smoke
- **WHEN** an eligible public skill-selection turn runs in a disposable OMP session with validated v2 evidence
- **THEN** automatic skill context is observed, model/prefix are unchanged, and guarded/opted-out turns produce no JEV call.
