# Product quality contract

## ADDED Requirements

### Requirement: Honest native project verification
The existing auto-review SHALL execute applicable existing project build/typecheck/lint/test commands and explicit operator argv checks, without automatic installation. It SHALL expose pass/fail/not-applicable/unverified per check, retain the existing JSON envelope fields and fail closed for failed or missing required evidence. A project with no product checks SHALL NOT receive an overall PASS from debt checks alone.

#### Scenario: Broken build despite green test
- **GIVEN** a project whose declared build fails and tests pass
- **WHEN** auto-review runs
- **THEN** build is fail and the CLI exits nonzero with ok false

#### Scenario: Missing required command
- **GIVEN** a project without a declared check:perf script
- **WHEN** auto-review is called with --require check:perf
- **THEN** it reports unverified and exits1 without installing a tool

#### Scenario: Inapplicable tool versus missing evidence
- **GIVEN** a project with a passing explicit native check and no TypeScript/build requirement
- **WHEN** auto-review runs
- **THEN** the explicit check is pass, inapplicable categories are not-applicable and overall is pass

#### Scenario: Native command or lint/types failure
- **GIVEN** an applicable project check that exits nonzero or cannot be launched
- **WHEN** auto-review executes it
- **THEN** execution failure is fail or absent execution is unverified, both nonzero, never report-only success

#### Scenario: Invalid input never dispatches
- **GIVEN** malformed JSON argv, empty command, invalid required name or unknown flags/positionals
- **WHEN** CLI parses input
- **THEN** it exits2 before any project command runs

### Requirement: Applicable measurable quality guidance
The canonical workflow SHALL record product quality scenarios in existing manifest/interfaces: actor/action/result, workload/environment, applicable resource/performance limits, command and evidence; nonapplicability needs a reason. It SHALL distinguish product outcomes from harness checks, token/cost footprint and model-quality claims.

#### Scenario: Feature planning and acceptance
- **WHEN** a relevant feature is planned and accepted
- **THEN** its existing contract identifies measurable outcomes and actual commands, and Oracle reports missing applicable proof rather than inferring it from artifacts

### Requirement: Useful architecture and conditional UI
Shipped roles SHALL preserve load-bearing information-hiding and testing boundaries even with one implementation; LOC is advisory, not a quality verdict. UI instructions SHALL follow existing brand/system and accessibility, apply research/motion/marketing only when relevant, and distinguish screenshot proof from interactive-flow/keyboard/responsive proof.

#### Scenario: Existing visual system
- **GIVEN** an existing project using Inter or system fonts and its own tokens
- **WHEN** a small UI change is requested
- **THEN** policy does not mandate a font/style replacement, animation tooling or conversion research

### Requirement: Consumer outcome evaluation without new orchestration
The existing benchmark SHALL include a substantive independently checked consumer task and explain how to evaluate a subsequent requirement change and UI outcomes. Broken and valid local controls SHALL establish that its check discriminates behavior. No model dispatch, fake fallback implementation or universal quality gain SHALL be claimed from these controls.

#### Scenario: Deterministic checker controls
- **WHEN** a deliberately broken and a valid consumer are exercised locally
- **THEN** the check refuses the broken outcome and accepts valid boundary behavior, preserving actual measured outputs and the no-inference limit

#### Scenario: Maintainability and measurement limits
- **GIVEN** a working consumer with an existing public behavior and a subsequent refund-handling requirement
- **WHEN** its changed implementation is assessed
- **THEN** independent checks exercise both prior and added behavior plus invalid inputs, retain observed workload timing/environment and explicitly identify unmeasured readability/UI/model-quality outcomes
- **AND** the documented follow-up protocol records change impact and human explanation without equating fewer lines with maintainability or claiming an unexecuted change succeeded
