# Evidence before automatic activation

## ADDED Requirements

### Requirement: Benefit evaluation MUST use held-out outcomes

The evaluation MUST separate calibration from at least 40 held-out RU/EN skill/risk cases and at least 8 deterministic low-risk leaf tasks covering explicit archetypes. The skill baseline MUST be a pinned chat model selecting skill/none from the same catalog; report accuracy, attempted precision, all-case recall, coverage, no-skill false positives and critical misses. Baseline/candidate arms MUST receive identical inputs/output limits; every failed request MUST count in denominators and costs. Primary cheap success MUST exclude baseline fallback success; assisted recovery MUST be reported separately with its full extra cost. No simulated/provider-doc demonstration is proof of live utility.

#### Scenario: Live paired evaluation
- **WHEN** the live evaluation runs within its explicit spend cap
- **THEN** output records model versions, denominators, accepted outcomes, mismatches, fallback counts and actual costs; savings are attributed only to the evaluated model pair/scope.

### Requirement: Activation MUST be tied to valid evidence

A persisted policy MUST validate exact report hash, catalog/model fingerprints and expiry; unsuccessful/stale categories MUST NOT activate. Skill activation MUST have zero critical miss, >=70% attempt coverage, >=95% attempted precision no worse than baseline precision, and lower measured decision cost or quality improvement. Routing activation MUST have cheap-primary accepted count no lower than baseline, zero safety miss and lower full cost per accepted outcome; baseline fallback successes MUST NOT inflate cheap-primary quality. Routing MUST be restricted to leaf-task archetypes evaluated (`lookup,json-transform,formatting,text-normalization`), not general role-wide cost claims. Held-out data MUST NOT be retuned until it passes.

#### Scenario: Failed routing benchmark
- **WHEN** routing quality is worse or accepted-outcome cost is not lower than baseline
- **THEN** cheaper automatic routing remains disabled and the report explains the measured result.

#### Scenario: Catalog or model changes
- **WHEN** the active catalog/model/report identity no longer matches evaluated evidence
- **THEN** assistance falls back automatically instead of trusting old thresholds.

### Requirement: Native behavior MUST be exercised end to end

Acceptance MUST observe actual OMP turn injection and actual child model selection, plus opt-out/failure/privacy paths, rather than only mocked event calls. New external API paths MUST have a sanitized live cassette verified with the existing replay tool.

#### Scenario: Real native smoke
- **WHEN** an eligible child task runs in a disposable OMP session
- **THEN** its reported provider/model matches the approved route, the deterministic task outcome is correct and protected tasks stay on baseline.
