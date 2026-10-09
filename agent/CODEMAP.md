# agent/

## Responsibility
Configuration Template and Agent Persona Registry for the OMP harness. Distributes declarative environment defaults, provider/model catalogs, plugin manifests, MCP fleet presets, and specialized subagent behavioral specifications seeded into active runtime profiles by `install.ps1`.

## Design Patterns
- **Prototype / Configuration Template**: Parameterized blueprints (`*.example`, `plugins.json`) instantiated with user credentials and runtime paths via token substitution (`__DEFAULT_MODEL__`).
- **Strategy / Persona Specification**: Role definitions (`agents/*.md`) configure specialized capabilities, tool allowlists, and system prompts for task delegation.
- **Extension / Interceptor Hook**: `extensions/nullform-jev.ts` implements the OMP `ExtensionAPI` lifecycle hook (`before_agent_start`) for policy-driven skill recommendations.
- **Ranked Registry**: `oracle-priority.example.json` and `models.yml.example` define prioritized fallback sequences and provider endpoint mappings.

## Data & Control Flow
1. Installer (`install.ps1`) injects user API keys and models into `.example` templates and copies them to `~/.omp/agent/`.
2. OMP session initializes runtime plugins declared in `plugins.json` and spins up configured MCP servers from `mcp.json`.
3. Native extension (`nullform-jev.ts`) intercepts `before_agent_start`, evaluating skill triggers before execution.
4. Orchestrator reads `AGENTS.md` to classify workflow tiers (T0–T3) and delegates tasks to subagent personas (`fixer`, `oracle`, `designer`) using model roles defined in `config.yml`.

## Integration Points
- **Lifecycle Hooks**: `before_agent_start` via `@oh-my-pi/pi-coding-agent` Extension API.
- **OMP Engine & Tools**: Consumed by `install.ps1`, `tools/workflow.mjs`, and OMP core runner.
- **External Interfaces**: MCP stdio servers (`codebase-index`, `context7`, `dap-debugger`, `chrome-devtools`), model providers in `models.yml`, and npm plugin registry specs in `plugins.json`.
