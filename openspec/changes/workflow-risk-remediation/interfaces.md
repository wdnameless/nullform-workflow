# Interfaces and file ownership

Keep public CLI flags and output shapes unless a finding explicitly requires a correction. No shallow compatibility wrappers or new external runtime dependency are needed.

| Consumer contract | Existing seam / expected behavior | Gemini owner |
|---|---|---|
| Sync CLI `--check/--deploy/--promote`, manifest target roots | Resolve roots before path substitution; all active enterprise-rule copies agree; promote preflight remains all-or-nothing | Sync worktree: `tools/sync.mjs`, `tools/sync-manifest.json`, `tools/tests/sync.test.mjs` |
| T0–T3 `workflow.mjs start/artifact/check/close/check-ci` | Local/CI evidence agreement, strict git error handling, measured changes and full oracle verdict set | Gate worktree: `tools/workflow.mjs`, CI workflow/template, `tools/tests/workflow*.test.mjs` and `bash-gates.test.mjs` |
| Dashboard `sessionKey`, `runtimePath`, `ensureDashboard`, CLI `--session`, `/api/health` | One server belongs to one project/session, paths stay inside project, same-session reuse still works | Dashboard worktree: `tools/dashboard.mjs`, `tools/tests/dashboard.test.mjs` |
| OMP installer PowerShell/Node CLI, MCP template | Copy required rule files and size baseline, select platform-native MCP execution, reject nested destination; supplied dummy config values become usable | Installer worktree: `install.ps1`, `tools/install-harness.mjs`, `agent/mcp.json.example`, `tools/verify.mjs`, `tools/doctor.mjs`, install tests |
| Repo dependency declarations | Exact stable versions where declared, current supported minima for Python dev requirements; no live secret or global plugin write | Dependency worktree: `agent/plugins.json`, two Python requirements; send CI/MCP pin information to their owners |

Parent integration only: `.code-size.baseline.json`, OpenSpec docs, README if necessary, version reconciliation, git/PR. Every Gemini worker MUST leave all other owner files untouched and skip full build/lint/test/formatter mid-flight; parent runs them after integration. Worktree paths are OS-temp, not parent directories.
