# tests/

## Responsibility
End-to-end integration test harness and CI regression guard suite. Unlike unit-level Node tests under `tools/tests/` (which test JS utilities via `node:test`), this directory hosts standalone PowerShell test harnesses that validate real filesystem mutations, installer immutability, data-loss guards, and configuration parity across process boundaries in isolated temporary environments.

## Design Patterns
- **Sandbox / Test Bed**: Builds isolated directory trees (`[System.IO.Path]::GetTempPath()`) with synthetic user homes, guaranteed clean via `try ... finally`.
- **Immutability / Baseline Assertion**: Computes pre-run SHA256 hashes of tracked repo files to assert zero installer mutation on source files.
- **Byte-Level Verification**: Inspects raw byte streams (`Assert-NoBom`) ensuring strict JSON parser compatibility by rejecting UTF-8 BOMs (`EF BB BF`).
- **Safety Interlock**: Recreates timestamp skew to verify refusal semantics (exit code 2) before allowing destructive sync or promote operations.

## Data & Control Flow
1. Test harness creates a GUID-named sandbox in `%TEMP%` and populates mock repo/live/home trees.
2. Spawns child processes (`powershell.exe`, `node.exe`) targeting `install.ps1`, `setup-paseo.ps1`, `tools/sync.ps1`, or `tools/doctor.mjs`.
3. Captures streams and inspects exit codes (`$LASTEXITCODE`).
4. Validates on-disk JSON structures (`ConvertFrom-Json`), byte markers, and drift state.
5. `finally` block recursively removes the sandbox directory.

## Integration Points
- **CLI Entry Points**: Exercises `install.ps1`, `tools/sync.ps1`, `paseo/setup-paseo.ps1`, `tools/doctor.mjs`, `tools/audit.ps1`, and `tools/skills-doctor.mjs`.
- **Target Schemas**: Validates Paseo daemon config (`daemon.agentProfiles`), MCP configs (`mcp.json`), and skill manifests (`SKILL.md`, `.skills-disabled.json`).
- **Runtimes**: Orchestrated via PowerShell (`powershell.exe -NoProfile -ExecutionPolicy Bypass`) and Node.js (`node`).
- **CI Pipeline**: Serves as standalone pre-merge regression barrier separate from Node test runners.
