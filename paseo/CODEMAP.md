# paseo/

## Responsibility
Workspace integration provisioner and configuration toolchain. Idempotently provisions workflow agent profiles (`agent_profile_orchestrator`) into external Paseo daemon configuration (`~/.paseo/config.json`) without mutating unrelated profiles or restarting running daemons.

## Design Patterns
- **Declarative Profile Template**: `profiles.json` defines portable profile metadata, capabilities, and orchestrator constraints.
- **Idempotent Reconciler**: `setup-paseo.ps1` matches target profiles by ID or provider/name tuple, preserving user-customized models and external profiles.
- **Atomic File Replacement**: Writes serialized configuration to a temporary UUID file before atomic swap (`[System.IO.File]::Replace`) with rollback handling.
- **Template Token Expansion**: Dynamic string interpolation replaces `<HarnessRoot>` with the resolved harness directory path.

## Data & Control Flow
- **CLI Ingestion**: `setup-paseo.ps1` receives optional `-Model`, `-HarnessRoot`, `-UserProfileDir`, and `-Force` switches.
- **Source & State Loading**: Reads `profiles.json` and parses existing `~/.paseo/config.json` (aborts on malformed JSON).
- **Profile Merging**: Filters `daemon.agentProfiles`; passes through third-party profiles, updates owned profiles (expanding `<HarnessRoot>`), and inserts missing profiles (validating non-empty model).
- **Atomic Serialization**: Converts config to JSON (depth 30, UTF-8 without BOM) and replaces `config.json` via staging file.

## Integration Points
- **Upstream Files**: Reads `profiles.json`, resolves harness path from `~/.omp/agent/.harness-root` or script parent; references `agent/agents/orchestrator.md`.
- **Target Consumer**: Paseo daemon configuration at `~/.paseo/config.json` (`daemon.agentProfiles`), loaded on `paseo daemon reload`.
