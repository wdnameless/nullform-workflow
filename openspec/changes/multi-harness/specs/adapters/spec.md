# multi-harness — spec deltas

## ADDED Requirements

### Requirement: OpenClaw adapter installs skills, agents and MCP
The installer SHALL support `--harness openclaw`: skills to `~/.openclaw/skills/<name>/SKILL.md`,
agent entries in `openclaw.json` + `AGENTS.md`/`SOUL.md` in workspace, MCP under `mcp.servers`.

#### Scenario: OpenClaw dry-run install
- **WHEN** running `install-harness.mjs --harness openclaw --root <tmp> --dry-run --json`
- **THEN** exit is 0 and the plan lists openclaw skills/agents/mcp paths.

### Requirement: Hermes adapter installs skills, agents and MCP
The installer SHALL support `--harness hermes`: skills to `$HERMES_HOME/skills/`,
`AGENTS.md` + profiles, MCP under `mcp_servers` in `config.yaml`.

#### Scenario: Hermes dry-run install
- **WHEN** running with `--harness hermes`
- **THEN** exit is 0 and generated `config.yaml` contains `mcp_servers`.

### Requirement: OpenHuman adapter installs by copying
The installer SHALL support `--harness openhuman`: skills copied (never symlinked)
to `agents/<id>/skills/<name>/SKILL.md`, `AGENTS.md` conventions kept.

#### Scenario: OpenHuman install copies files
- **WHEN** installing with `--harness openhuman`
- **THEN** skill files are real copies and no symlink is created.

### Requirement: README one-phrase install prompt
README SHALL contain a copy-paste prompt by which an agent detects the host harness,
shows the install table, and installs the selected adapter.

#### Scenario: Prompt detects and proposes
- **WHEN** an agent follows the README prompt on a machine
- **THEN** it names the detected harness and offers the install choice.

### Requirement: Release versioning and notify-plus-command update
The repo SHALL carry a `VERSION` file; `self-update check` SHALL report drift from
the GitHub latest release; `self-update update` SHALL fast-forward and reinstall
idempotently; doctor SHALL WARN (not fail) on drift; sync deploy SHALL back up
overwritten live files.

#### Scenario: Drift check warns
- **WHEN** local VERSION is behind the GitHub latest release
- **THEN** `check` reports drift and doctor emits WARN.

#### Scenario: Update is one command
- **WHEN** running `self-update update` on a drifted install
- **THEN** it fast-forwards, reinstalls, backs up overwritten files, and doctor passes.
