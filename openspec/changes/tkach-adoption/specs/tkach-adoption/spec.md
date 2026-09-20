# Tkach adoption pack

## ADDED Requirements
### Requirement: Stage B simplifies before acceptance
After implementation tests pass and before blind acceptance, the orchestrator SHALL run one simplification iteration per code slice whose behaviour is covered by tests; stage-A tests SHALL remain unmodified and SHALL pass again after the pass; the pass SHALL report removed lines.
#### Scenario: Over-built slice
- **WHEN** a slice passes its tests but the reviewer's lean lens reports `net: -N lines possible`
- **THEN** the Stage B pass is applied, stage-A tests stay untouched, re-run green, and the report names the net line delta

### Requirement: Prompt surfaces have a budget and an owner
`prompt-lint sizes` SHALL report always-loaded surfaces, role definitions, rules and the skills registry against configurable budgets, and `--check` SHALL exit 1 on a violation; the always-loaded law SHALL state that prompt surfaces are human-owned.
#### Scenario: Budget breach
- **WHEN** the always-loaded law grows past the configured byte budget
- **THEN** `sizes --check` fails and audit reports the violation

### Requirement: Tool usage is measurable
`usage-audit` SHALL rank MCP tools, built-in tools and skill reads from real session transcripts and SHALL list configured MCP servers and installed skills that never appear in the window, without printing message content.
#### Scenario: Unused server
- **WHEN** a configured MCP server has no tool calls in the window
- **THEN** it appears under unused servers with the window length named

### Requirement: Install is verified, not trusted
`doctor` SHALL verify the installed tree (harness files, tool syntax and smoke runs, agent-dir wiring, skills parity, prompt baseline) and `install.ps1` SHALL fail loudly when any check fails.
#### Scenario: Missing role file after install
- **WHEN** a role definition is absent from the agent directory
- **THEN** doctor reports FAIL for agent wiring and the installer exits non-zero with that line printed
