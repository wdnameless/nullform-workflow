# Model routing

## ADDED Requirements

### Requirement: Checker assignment MUST enforce model diversity

`assignChecker({ writerFamily, candidates })` MUST return a candidate whose
family differs from `writerFamily`, reusing the round1 family rule, or throw
naming the conflict.

#### Scenario: Same-family checker refused
- **WHEN** all candidates share the writer's family
- **THEN** assignment throws and names the conflicting family.

### Requirement: Usage MUST normalize per provider with UNKNOWN gaps

`normalizeUsage(provider, raw)` MUST derive provider-correct totals (Anthropic
cache fields additive, OpenAI cache fields subsets). Any unreported field MUST
be `UNKNOWN`, never 0.

#### Scenario: Provider fixtures
- **WHEN** Anthropic-shaped and OpenAI-shaped raw usage are normalized
- **THEN** totals match each provider's semantics and gaps read UNKNOWN.

### Requirement: Circuit breaker MUST fail back on retryable failures

`withBreaker(fn, { reserve, threshold })` MUST open after `threshold`
consecutive retryable failures (429/503-shaped errors) and route to `reserve`.
After a successful probe the breaker MUST close.

#### Scenario: Breaker lifecycle
- **WHEN** failures reach the threshold then a probe succeeds
- **THEN** calls fail back while open and resume primary after close.
