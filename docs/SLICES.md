# Architecture Slices (S0..S4) & Integration Levels (L0..L3)

Clean architecture slice decomposition for universal workflow adoption. Dependencies are strictly downward.

## Slices

### S0: Core
- **Purpose**: Foundational contracts, work lanes (T0..T3), requirements manifest format (`R##`), and blind acceptance protocol. Zero external dependencies.
- **Files**: `core/PORTABLE.md`, `CONTEXT.md`.
- **Dependencies**: None (leaf).

### S1: Gates
- **Purpose**: Five automated quality gates reusable across any project or foreign repository root (`--root`): mutation, coverage, clone, code-size, and quality.
- **Files**: `tools/mutation-changed.mjs`, `tools/coverage-changed.mjs`, `tools/clone-coverage.mjs`, `tools/code-size.mjs`, `tools/changed-scope.mjs`, `bin/nullform.mjs` (quality), `docs/GATES.md`.
- **Dependencies**: S0.

### S2: Roles
- **Purpose**: Multi-agent coordination personas, NEXUS 3-retry escalation in reviewer, and Reality Checker default in oracle.
- **Files**: `agent/AGENTS.md`, `agent/agents/orchestrator.md`, `agent/agents/reviewer.md`, `agent/agents/oracle.md`.
- **Dependencies**: S0.

### S3: Install
- **Purpose**: Declarative multi-harness matrix and zero-dep guided interactive CLI installation wizard (`nullform init`).
- **Files**: `tools/harness-matrix.json`, `tools/install-harness.mjs`, `bin/nullform.mjs`.
- **Dependencies**: S0.

### S4: Integrate
- **Purpose**: External agent onboarding prompt, audit procedures, and structured migration levels (L0..L3).
- **Files**: `prompts/integration.md`, `docs/AGENT-INTEGRATION.md`.
- **Dependencies**: S0, S1.

### Dependency Hierarchy
```
S4 (integrate) ──┬──> S1 (gates) ──> S0 (core)
                 └──> S0 (core) <──── S2 (roles)
                      ^
                      └── S3 (install)
```

## Integration Levels

Adopt the workflow incrementally according to project needs:

| Level | Name | Slices | Included Capabilities |
|---|---|---|---|
| **L0** | gates-only | S0, S1 | Reusable quality gates (5 gates in CI/local), zero changes to project workflow |
| **L1** | lanes+manifest | S0, S1 | L0 + task tiering (T0..T3), `manifest.md` requirements traceability (`R##`) |
| **L2** | full SDD | S0, S1, S2 | L1 + 4-Wave SDD, parallel subagent roles, Stage B review, blind oracle |
| **L3** | managed | S0, S1, S2, S3, S4 | L2 + interactive wizard (`nullform init`), harness matrix, prompt integration |

### Level Details
- **L0 (gates-only)**: Run 5 gates via `nullform quality` or standalone scripts in foreign roots (`--root`). No agent or lane changes required.
- **L1 (lanes+manifest)**: Standardize work into T0..T3 lanes and write atomic `R##` requirements before coding.
- **L2 (full SDD)**: Full Spec-Driven Development with Wave 0 grilling, Wave 1 context, Wave 2 OpenSpec, Wave 3 parallel subagents, Wave 3.5 review (NEXUS escalation), Wave 4 oracle (Reality Checker).
- **L3 (managed)**: Complete installation across harnesses (Codex, Claude, Hermes, OMP, OpenHuman, Cursor, OpenCode, OpenClaw, custom) with automated updates and wizard flows.

## Fork Implementation Note: Interactive UI (@clack/prompts)
The upstream `nullform init` wizard intentionally uses Node.js core `readline` to guarantee zero third-party dependencies during installation. Downstream forks or host tools that prefer richer terminal visuals (spinners, animated multi-selects, styled bento boxes) are recommended to swap readline for `@clack/prompts` (as demonstrated in paperclip/openclaw). S0..S4 slice contracts remain identical regardless of the UI layer.
