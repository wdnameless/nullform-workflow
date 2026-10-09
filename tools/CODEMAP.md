# tools/

## Responsibility
CLI Toolchain, Governance Facade, and Diagnostic Harness for the OMP workflow. Provides drift synchronization, tier-based SDD workflow enforcement, static prompt and code linting, cross-platform verification gates, and observability dashboards for agent operations.

## Design Patterns
- **CLI Toolchain / Dispatcher Facade**: Subcommand routers (`workflow.mjs`, `sync.mjs`, `codemap.mjs`, `jev-control.mjs`) exposing high-level commands over filesystem operations and child process spawning.
- **Strategy**: Pluggable verification and gate profiles (`verify` vs `audit` in `verify.mjs`), tier enforcement strategies (T0–T3 in `workflow.mjs`), and sync reconciliation modes (`--check`, `--deploy`, `--promote`, `--prune` in `sync.mjs`).
- **Registry / Manifest-Driven Configuration**: File mapping tables (`sync-manifest.json`), tool validation lists (`CORE_TOOLS` in `doctor.mjs`), and hierarchical requirement tables (`REQUIREMENTS` in `workflow.mjs`).
- **Doctor / Diagnostic Probe**: Independent health check runners (`doctor.mjs`, `cache-doctor.mjs`, `skills-doctor.mjs`) returning normalized status envelopes (`pass`, `warn`, `fail`, `skip`).
- **Observer / State Server**: `dashboard.mjs` aggregates repository scanners, workflow artifacts, and git state into an HTTP server (`/api/state`, `/api/diff`) and browser cockpit.

## Data & Control Flow
1. CLI entry points parse arguments, resolve runtime roots (`harnessRoot`, `repoRoot`, `agentDir`), and read configs (`models.yml`, `sync-manifest.json`, `.workflow/state.json`).
2. Sync engine computes file hashes, comparing repository sources with the live harness (`~/.agents`, `~/.omp/agent`) to detect drift, deploy, or promote changes.
3. Workflow engine validates required deliverables (recon notes, manifests, interfaces, oracle verdicts) against the active tier ladder, writing state to `.workflow/state.json`.
4. Verification engine (`verify.mjs`) executes sub-tool suites (`prompt-lint`, `doctor`, tests), aggregating results into structured console output or JSON.
5. Dashboard ingests scan results (`debt-ledger`, `git diff`) and serves real-time state via HTTP endpoints.

## Integration Points
- **CLI / Host Harness**: Invoked by `install.ps1`/`install.sh`, `audit.ps1`/`audit.sh`, `omp` CLI, and `openspec`.
- **Agent Extensions & Plugins**: Interfaces with `agent/extensions/nullform-jev.ts` via JEV policies (`jev-policy.json`, `jev-evidence.mjs`).
- **Shared Data Contracts**: `.workflow/state.json`, `.workflow/budgets.json`, `.codemap/state.json`, `sync-manifest.json`, and `agent/models.yml`.
- **System Boundaries**: Spawns Node, PowerShell, bash, git, and HTTP server on loopback localhost.
