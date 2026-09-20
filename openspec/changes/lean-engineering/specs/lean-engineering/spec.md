# Lean engineering

## ADDED Requirements
### Requirement: Ladder precedes code
Executing roles (fixer, designer) SHALL climb the solution ladder — need? → reuse → stdlib → native platform → installed dependency → one line → minimum — after understanding the task, and SHALL NOT simplify away trust-boundary validation, data-loss error handling, security, accessibility, or anything explicitly requested.
#### Scenario: Native feature covers the request
- **WHEN** a component asks for a dependency the platform already ships
- **THEN** the implementation uses the native feature and says in one line what was skipped

#### Scenario: Bug report names a symptom
- **WHEN** a fix is requested for a reported symptom
- **THEN** every caller of the touched function is inspected and the fix lands at the shared root, not on the named path only

### Requirement: Over-engineering review is tagged and quantified
The reviewer SHALL emit over-engineering findings tagged `delete: / stdlib: / native: / yagni: / shrink:`, each naming its replacement, and SHALL end the verdict with `net: -N lines possible` or `Lean already.` The minimum runnable check is never flagged; correctness, security and performance findings remain outside this lens.
#### Scenario: Twenty-line hand-rolled helper over a stdlib call
- **WHEN** a patch hand-rolls what the standard library ships
- **THEN** the finding is tagged `stdlib:`, names the function, and the verdict counts the removable lines

### Requirement: Defer markers are auditable
A deliberate simplification with a known ceiling SHALL be marked `defer: <what> | ceiling: <limit> | upgrade: <trigger>` in a single-line comment; a marker without an `upgrade:` trigger SHALL be treated as rot risk.
#### Scenario: Marker without a trigger
- **WHEN** `tools/debt-ledger.mjs scan --check` runs over a repository containing a `defer:` marker with no `upgrade:`
- **THEN** the command exits 1 and the marker is listed as `no-trigger`

#### Scenario: Clean ledger
- **WHEN** no markers exist
- **THEN** scan reports a clean ledger and `--check` exits 0

### Requirement: Debt reaches the architecture report
No-trigger markers SHALL surface as `maintainability` / `debt-no-trigger` problems in the archmap analysis and its HTML report, without new client code.
#### Scenario: No-trigger marker in a scanned file
- **WHEN** archmap scans a project whose file carries an untriggered marker
- **THEN** `archmap json` contains a `debt-no-trigger` problem for that file and line
