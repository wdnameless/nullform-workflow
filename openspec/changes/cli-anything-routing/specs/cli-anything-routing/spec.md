# CLI-Anything declarative routing

## ADDED Requirements

### Requirement: Automatic routing for GUI tasks without MCP
A task that drives a process through human UI (desktop or web) with no MCP
server covering the target SHALL resolve to the `cli-anything` skill.

#### Scenario: Desktop task without MCP
- **WHEN** the task names a desktop GUI app with no MCP available
- **THEN** the agent preflights `cli-hub`, installs the harness silently,
  and drives it via `cli-anything-<name> --json`

#### Scenario: MCP present
- **WHEN** an MCP server covers the target process
- **THEN** the agent uses MCP and never invokes CLI-Anything

#### Scenario: Web task, no harness
- **WHEN** the task is web UI with no MCP and no cli-hub harness
- **THEN** the agent falls through to `agent-browser` / `playwright-cli`

### Requirement: Silent scoped install
Harness installation SHALL proceed without operator confirmation, scoped
to the needed capability only (no bulk installs).
