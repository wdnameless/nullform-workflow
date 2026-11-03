# bin/

## Responsibility
CLI entrypoint layer of the `nullform-workflow` npm package. `bin/nullform.mjs` is the single shipped executable (`package.json` → `bin.nullform`); it owns interactive setup UX and forwards every operational subcommand to `tools/`. It is a thin dispatcher, not a business-logic layer: no domain rules live here.

## Design Patterns
- **Facade / Forwarding Dispatcher**: one `parseCliArgs` argv parser, then a `switch` that imports the owning tool module and calls its `main`/command handler. Each subcommand has exactly one downstream owner.
- **Wizard / Prompt Chain (Interactive Setup)**: `runInit` is a sequence of bounded prompt steps — `promptHarnessMenu` → `resolveMenuSelection` → `promptFlowStep` → `promptSlicesStep` → `promptConfirmPlan` — driven by declarative catalogs (`HARNESS_MENU_ITEMS`, `SLICES_CATALOG`, `HARNESS_MATRIX_PATH`). Headless mode (`--yes --json`) bypasses prompts and emits a single JSON document.
- **Declarative Catalog + Loader**: `loadHarnessMatrix` reads `tools/harness-matrix.json`; `getHarnessMenuItems` turns it into menu entries, so adding a harness is data, not code.
- **Delegation over Duplication**: version/identity resolution (`readPackageVersion`, `PACKAGE_ROOT`), install planning and state all come from `tools/installation/*`, never re-implemented.

## Data & Control Flow
1. `parseCliArgs(process.argv)` → subcommand + flags (`--yes`, `--json`, `--tier`, `--task`, …).
2. Dispatch table forwards: `init`/`setup` → `runInit` (harness menu → flow step → slices → confirm → `tools/install-harness.mjs`); `doctor` → `tools/doctor.mjs`; `update` → `tools/self-update.mjs`; `workflow` → `tools/workflow.mjs`; harness probing → `tools/harness-probe.mjs` + `tools/harness-setup.mjs`.
3. Install path: `tools/installation/capabilities.mjs` (host presence) → `profiles.mjs` (host home/manifest) → `journal.mjs` (lock + recoverable journal) → `state.mjs` (identity, SemVer, effective prefix) → adapters write; failures roll back through `restore.mjs`.
4. Exit code is the contract: 0 success, 1 failure; `--json` mode keeps stdout a single parseable object (CI-certified invariant — see `fix(ci): single JSON on headless init --yes --json`).

## Integration Points
- **Imports**: `../tools/doctor.mjs`, `../tools/harness-probe.mjs`, `../tools/harness-setup.mjs`, `../tools/install-harness.mjs`, `../tools/self-update.mjs`, `../tools/workflow.mjs`, `../tools/installation/{capabilities,journal,profiles,state}.mjs`.
- **Exported surface** (consumed by `tools/tests/`): `parseCliArgs`, `loadHarnessMatrix`, `getHarnessMenuItems`, `resolveMenuSelection`, `runInit`, `PACKAGE_ROOT`, `readPackageVersion`, `SLICES_CATALOG`.
- **Consumers**: npm global install (`nullform` on PATH), `install.ps1`/`install.sh`, and test suites `tools/tests/init-wizard.test.mjs`, `coverage-changed.test.mjs`, `harness-probe.test.mjs` (all import `../../bin/nullform.mjs` directly).
- **State touched**: installation state file (via `installation/state.mjs`), deployment journal + lock (via `installation/journal.mjs`), `tools/harness-matrix.json` (read).
