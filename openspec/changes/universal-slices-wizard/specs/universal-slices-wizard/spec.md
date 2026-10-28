# Universal slices wizard

## ADDED Requirements

### Requirement: External ideas adopted
Harness matrix (agency tools.json idea), wizard pattern (openclaw/paperclip),
NEXUS 3-retry escalation, and Reality Checker default SHALL be present
with MIT attribution.

#### Scenario: Matrix drives install menu
- **WHEN** `nullform init` lists harnesses
- **THEN** entries come from tools/harness-matrix.json (8+custom)

#### Scenario: Reviewer hits 3rd failed round
- **WHEN** the same defect fails fixing 3 times
- **THEN** the reviewer HANDOFFs with root-cause instead of trying again

### Requirement: Multi-harness universality
Codex, Claude, Hermes, and OpenHuman SHALL install via `nullform init`
(dry-run shows no OMP paths); OpenHuman SHALL be marked runtime-unverified.

#### Scenario: Codex dry-run
- **WHEN** `nullform init --dry-run --harness codex` runs
- **THEN** the plan names codex paths and no `~/.omp` entries

### Requirement: Gates as dev rules for any project
Mutation, coverage, clone, and code-size gates SHALL run against a foreign
project root with explicit scope/suites config; docs/GATES.md SHALL document
all five gates as reusable rules.

#### Scenario: Foreign project gated
- **WHEN** gates run with --root on a fixture project without tools/tests
- **THEN** they scope, match suites, and verdict instead of crashing

### Requirement: Agent integration prompt shipped
docs/AGENT-INTEGRATION.md + prompts/integration.md SHALL let a user feed
their agent a prompt that audits their setup and picks integration level
L0..L3 with a plan.

#### Scenario: Prompt walkthrough
- **WHEN** the prompt is followed on a gates-only setup
- **THEN** it concludes L0 with a concrete install plan

### Requirement: Clean slices documented
docs/SLICES.md SHALL define S0..S4 with files, downward-only dependencies,
and the L0..L3 mapping.

#### Scenario: Slice lookup
- **WHEN** an engineer asks what S1 contains and needs
- **THEN** SLICES.md answers: gates, files, depends on S0 only

### Requirement: Guided install wizard
`nullform init` SHALL walk flow→harness→slices→dry-run→confirm with back
navigation and non-TTY defaults, covered by piped-stdin tests.

#### Scenario: Back navigation
- **WHEN** the user types `..` at the slices step
- **THEN** the wizard returns to harness choice with prior answers kept
