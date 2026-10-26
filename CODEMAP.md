# <root>/

## Responsibility
Root repository boundary, orchestration harness coordinator, and distributed npm package (`nullform-workflow`) for AI coding agents. Declares package metadata, runtime dependencies (`json5`, `jsonc-parser`, `yaml`), dev tooling (`eslint`, `@eslint/js`, `eslint-plugin-sonarjs`, `@fission-ai/openspec`, `globals`), and executable binary mapping (`bin.nullform -> bin/nullform.mjs`) in `package.json`. Houses OS bootstrap installers (`install.ps1`, `install.sh`), verification harnesses (`verify.ps1`, `verify.sh`), and audit entrypoints (`tools/audit.ps1`, `tools/audit.sh`). Governs repository-wide code quality and prose hygiene via flat ESLint config (`eslint.config.mjs`) and typos rules (`_typos.toml`), while securing skill registry integrity through cryptographic checksums in `skills-lock.json`. Coordinates the integration of primary subsystems: `tools/`, `agent/`, `skills/`, `bench/`, `core/`, `paseo/`, `jev/`, `openspec/`, and `tests/`.

## Design Patterns
- **Layered Plugin Harness**: Isolates platform-agnostic tools (`tools/`) and portable contracts (`core/`) from runtime adapters (`agent/`, `jev/`, `paseo/`) and specification tracks (`openspec/`).
- **Facade & Forwarding CLI**: `bin/nullform.mjs` acts as a unified command dispatcher (wiring `init`, `doctor`, `update`, `workflow`, `quality`, `evidence`, `inspect`), while shell wrappers (`install.ps1`/`install.sh`, `verify.ps1`/`verify.sh`, `tools/audit.ps1`/`tools/audit.sh`) forward execution to underlying Node scripts (`tools/install-harness.mjs`, `tools/verify.mjs`).
- **Cryptographic Lockfile Pinning**: `skills-lock.json` (alongside `package-lock.json`) enforces tamper-evident reproducibility by tracking `computedHash` and `folderHash` for external and repository skills.
- **Ratchet & Exemption Quality Filters**: `eslint.config.mjs` enforces core JavaScript invariants and complexity caps (`complexity: 200`) with relaxed rules for ratchet refactoring, while `_typos.toml` exempts hashes, transcripts, and code to protect evidence integrity.
- **Template Method**: Hydrates blueprint configurations (`secrets.example.env`, `agent/*.example*`) with local paths and credentials during setup.
- **Finite State Machine**: Enforces deterministic T0–T3 SDD transitions through `tools/workflow.mjs` backed by `.workflow/state.json`.

## Data & Control Flow
1. **Package Consumption & CLI Wiring**: The package is consumed either via npm (`npm install -g nullform-workflow`) or git checkout. `package.json` maps the executable `nullform` binary to `bin/nullform.mjs`, which exposes CLI subcommands (`workflow`, `quality`, `init`, `setup`, `heal`, `inspect`, `doctor`, `update`, `capabilities`, `evidence`) delegating directly to `tools/`.
2. **Bootstrap & Installation**: Installation begins via `install.ps1` (PowerShell) or `install.sh` (POSIX shell), invoking `tools/install-harness.mjs`. It hydrates templates, provisions host directories (`~/.omp`, `~/.paseo`, `~/.agents`), installs dependencies, runs `tools/fix-plugin-windows.cjs` (on Windows), and executes `tools/doctor.mjs` verification.
3. **Verification & Audit Lifecycle**: One-command verification runs through `verify.ps1` or `verify.sh` (forwarding to `node tools/verify.mjs --profile verify`). Harness auditing runs through `tools/audit.ps1` or `tools/audit.sh` (forwarding to `node tools/verify.mjs --profile audit` and `tools/audit-profile.mjs`), validating profile configurations, file integrity, and test invariants.
4. **Linting & Code Hygiene**: Static analysis runs via `npm run lint` driven by `eslint.config.mjs` across `tools/`, `bin/`, and `bench/checks/`. Prose spellchecking runs through typos guided by `_typos.toml`. Code complexity and AST metrics are checked via `npm run quality` against `.quality-baseline.json`.
5. **Skill Resolution & Governance**: Agent capabilities in `skills/` are validated against `skills-lock.json` hash trees before execution. Agent workflows progress under `tools/workflow.mjs` lifecycle state transitions in `.workflow/state.json`.

## Integration Points
- **Package Distribution & Bin Wiring**: `package.json` defines package metadata, npm distribution allowlist (`files`), dependencies (`json5`, `jsonc-parser`, `yaml`), and binary entrypoint `bin/nullform.mjs`.
- **Install & Verification Wrappers**: Root entrypoints `install.ps1`, `install.sh`, `verify.ps1`, and `verify.sh`, alongside `tools/audit.ps1` and `tools/audit.sh`, forward platform CLI invocations to Node implementations in `tools/`.
- **Quality & Hygiene Configurations**: `eslint.config.mjs` (ESLint flat config with Node 2024 globals and complexity ceilings) and `_typos.toml` (prose spellchecking exclusions and dictionary extensions) establish automated linting boundaries.
- **Skill Integrity Registry**: `skills-lock.json` stores skill provenance, source repositories, and SHA-256 folder hashes for pinned skills in `skills/`.
- **Top-Level Subsystems**:
  - `tools/`: CLI toolchain, T0–T3 workflow engine (`workflow.mjs`), verification (`verify.mjs`), quality gate (`quality.mjs`), install drivers (`tools/installation/`), review gates (`tools/review/`), and diagnostics (`doctor.mjs`).
  - `agent/`: Agent persona specifications (`agent/agents/`), plugin manifests (`agent/plugins.json`), model blueprints (`agent/models.yml.example`), and OMP extension hooks (`agent/extensions/`).
  - `skills/`: Discoverable agent capability packages and tool implementations, referenced by lockfile hashes.
  - `bench/`: Evaluation framework comprising assertion checks (`bench/checks/`), task fixtures (`bench/fixtures/`), and benchmark runners.
  - `core/`: Host-agnostic workflow specifications, lifecycle contracts, and invariant definitions codified in `core/PORTABLE.md`.
  - `paseo/`: Workspace profile provisioning and setup scripts (`paseo/setup-paseo.ps1`) for external Paseo agent daemons.
  - `jev/`: Claude Code plugin distribution bundle, marketplace metadata, hooks, and JEV model routing/evaluation toolchain.
  - `openspec/`: OpenSpec change proposals, task breakdowns, architecture specifications, and legacy acceptance contracts (`openspec/changes/`).
  - `tests/`: Integration test suites and sandbox validation harnesses ensuring installer and toolchain stability.
- **Runtime Hosts & Services**: Coordinates Oh My Pi (`@oh-my-pi/pi-coding-agent`), Paseo daemons, Claude Code CLI, and local MCP servers (`codebase-index`, `context7`, `dap-debugger`).
