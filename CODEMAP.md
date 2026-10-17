# <root>/

## Responsibility
Workflow harness, one-command installer, and distributed npm package (`nullform-workflow`) for AI coding agents. Root `package.json` defines package metadata, versioning, dependencies, and executable bin entries; `bin/` serves as the CLI entry folder (separate map owner) exposing the `nullform` binary. Coordinates configuration templating (`agent/`), standalone CLI governance tools (`tools/`), Claude Code / Paseo integrations (`jev/`, `paseo/`), and cross-platform verification suites (`tests/`).

## Design Patterns
- **Layered Plugin Harness**: Separates platform-agnostic tools (`tools/`) from runtime adapters (`agent/`, `jev/`, `paseo/`).
- **Template Method**: Hydrates parameterized blueprints (`.example`) with environment secrets during installation.
- **Finite State Machine**: Manages T0–T3 SDD task lifecycles through deterministic gate transitions (`workflow.mjs`).
- **Interceptor & Strategy**: Employs lifecycle hooks (`before_agent_start`, `UserPromptSubmit`) for policy checks and skill routing.

## Data & Control Flow
1. **Bootstrap & Distribution**: Consumed either via npm package install (`npm install -g nullform-workflow` routing through `bin/nullform.mjs` defined in `package.json`) or direct checkout installation (`install.ps1`/`install.sh`), hydrating agent templates and provisioning host profiles (`~/.omp`, `~/.paseo`). `bin/` acts as the external CLI entry routing subcommands into underlying tools.
2. **Governance**: Agents trigger `tools/workflow.mjs` (directly or via `nullform workflow`) to transition tasks across T0–T3 states in `.workflow/state.json`.
3. **Interception**: Host sessions trigger extension hooks (`agent/extensions/`, `jev/hooks/`) to inject evaluated skill recommendations.
4. **Verification**: CI suites (`verify.ps1`, `tools/verify.mjs`, `tests/`) validate invariants and audit configuration drift.

## Integration Points
- **Package Distribution & CLI**: Root `package.json` defines package identity, versions, dependencies (`yaml`, `json5`, `jsonc-parser`), and bin mappings (`bin/nullform.mjs`), enabling distribution as an npm package alongside source checkouts.
- **Harness Hosts**: Oh My Pi (`@oh-my-pi/pi-coding-agent`), Paseo daemon, Claude Code CLI, and generic agents.
- **External Services**: OpenRouter / TypeSafe inference APIs, npm registries (for releases and updates), and local MCP stdio servers (`codebase-index`, `context7`, `dap-debugger`).
- **Shared State**: `.workflow/state.json`, `.codemap/state.json`, `sync-manifest.json`, and `agent/models.yml`.

## Repository Directory Map
| Directory | Responsibility | Detailed Map link |
|---|---|---|
| `agent/` | Configuration templates, subagent personas, and runtime profile specs | [./agent/CODEMAP.md](./agent/CODEMAP.md) |
| `agent/extensions/` | OMP lifecycle extension middleware for JEV skill suggestions | [./agent/extensions/CODEMAP.md](./agent/extensions/CODEMAP.md) |
| `bench/checks/` | Deterministic verification and evaluation assertion checks for benchmarks | [./bench/checks/CODEMAP.md](./bench/checks/CODEMAP.md) |
| `bench/fixtures/` | Reproducible benchmark task fixtures, setup scripts, and baseline outputs | [./bench/fixtures/CODEMAP.md](./bench/fixtures/CODEMAP.md) |
| `jev/` | Claude Code plugin marketplace distribution bundle and catalog root | [./jev/CODEMAP.md](./jev/CODEMAP.md) |
| `jev/plugins/` | Claude Code plugin container and namespace root | [./jev/plugins/CODEMAP.md](./jev/plugins/CODEMAP.md) |
| `jev/plugins/jev/` | JEV classification engine, model router, and evaluation toolchain | [./jev/plugins/jev/CODEMAP.md](./jev/plugins/jev/CODEMAP.md) |
| `jev/plugins/jev/hooks/` | Prompt submission event middleware injecting routing context | [./jev/plugins/jev/hooks/CODEMAP.md](./jev/plugins/jev/hooks/CODEMAP.md) |
| `jev/plugins/jev/scripts/` | CLI evaluation scripts and HTTP client facade for JEV APIs | [./jev/plugins/jev/scripts/CODEMAP.md](./jev/plugins/jev/scripts/CODEMAP.md) |
| `paseo/` | Workspace profile provisioning for external Paseo daemons | [./paseo/CODEMAP.md](./paseo/CODEMAP.md) |
| `tests/` | Sandbox CI integration test harness and immutable installer suites | [./tests/CODEMAP.md](./tests/CODEMAP.md) |
| `tools/` | CLI toolchain, T0–T3 workflow engine, sync, and diagnostic probes | [./tools/CODEMAP.md](./tools/CODEMAP.md) |
| `tools/tests/` | Unit and subprocess integration tests for tools and JEV policy suites | [./tools/tests/CODEMAP.md](./tools/tests/CODEMAP.md) |
