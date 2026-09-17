# Self CI + metrics + renderer split

## ADDED Requirements
### Requirement: Repo self-gate
Pushes and PRs to this repo SHALL run tests, openspec validation, archmap scan and auto-review.
#### Scenario: Pull request
- **WHEN** a PR opens
- **THEN** the workflow runs and fails on test/archmap gate failures

### Requirement: Task metrics
Every closed task SHALL append one JSON line with tier and duration; `metrics` SHALL aggregate them.
#### Scenario: Two closed tasks
- **WHEN** T0 and T2 tasks close
- **THEN** metrics.jsonl has 2 lines and `metrics` prints per-tier counts and average durations

### Requirement: Renderer file split
The client script and stylesheet SHALL live as real files; renderHtml output SHALL stay behaviorally identical.
#### Scenario: Render and parse
- **WHEN** renderHtml output client script is extracted
- **THEN** vm.Script parses it and all existing report tests pass
