## ADDED Requirements

### Requirement: Honest comparative evidence
The system SHALL validate and expose retained task/arm outcomes, model/session/input provenance, request counts, terminal failures and known tariff costs. It SHALL preserve equal/unfavorable outcomes and SHALL distinguish historical constructed comparisons, zero-network replay, deployment correctness and current causal quality benefit.

#### Scenario: Retained workflow failure
- **GIVEN** the existing four constructed pairs, with baseline workflow five recorded requests and candidate six requests without a final report
- **WHEN** the evidence report is generated or displayed
- **THEN** baseline completion, candidate failure and actual costs/counts are retained and positive general benefit is not claimed

#### Scenario: Changed release instructions
- **GIVEN** historical results tied to older fixture/skill/input hashes
- **WHEN** current prompts or source are changed
- **THEN** old results remain historical and are not relabeled as a fresh evaluation of the new release

### Requirement: Zero additional paid experiment dispatch
This program SHALL run no additional paid A/B inference and SHALL preserve the existing spend ledger. Deterministic/replay/native-offline checks SHALL label fabricated seams and historical output reuse honestly and SHALL not fabricate fresh sessions, usage or acceptance evidence.

#### Scenario: Offline regression certification
- **GIVEN** a release/test command declared deterministic or replay-only
- **WHEN** it is exercised under a network-denying model boundary
- **THEN** it finishes without live inference and reports only regression/format/consumer correctness, not a new model benefit measurement

### Requirement: Claims depend on adequate evidence
Public CLI/docs/package claims SHALL not state that the workflow improves development quality without adequate independent comparative evidence. Current limited equal/adverse comparisons SHALL produce an explicit not-proven assessment and limitations; missing/invalid data SHALL not become a positive fallback.

#### Scenario: Public release with no proven gain
- **GIVEN** user authorization to release without unproven claims and no new paid comparisons
- **WHEN** the release is certified and published
- **THEN** technical deployment/gate evidence is published separately from efficacy claims, which remain not proven
