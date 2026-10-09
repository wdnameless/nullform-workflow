# tools/tests/

## Responsibility
Test harness and regression test suite for the `tools/` CLI toolchain, workflow engine, cache auditing, and JEV subsystem. Provides deterministic unit tests, CLI subprocess acceptance tests, and empirical paired-evaluation harness validation.

## Design Patterns
- **Test Fixture / Object Mother**: Factory functions (`createGitRepo`, `createTempDir`, `makeValidReportFixture`) and static data sets (`fixtures/jev/`, `fixtures/cache/`) construct realistic runtime states.
- **Process Isolation**: CLI tools are exercised out-of-process via `spawnSync(process.execPath, ...)` in isolated OS temporary scratch trees with custom git repos and junctions.
- **Test Double / Spy**: Mock host environments (`createMockPi`, `createMockCore`) simulate event handlers, command registries, and skill catalogs for agent extensions.
- **Table-Driven Tests**: Parametric test suites iterate across calibration and heldout datasets to validate JEV policy thresholds and cost calculation models.

## Data & Control Flow
- Test runners (`node:test`, `unittest`) discover and execute test suites.
- Tests allocate ephemeral directories (`mkdtempSync`) or load static fixtures.
- Subprocess spawns or direct function calls invoke tool entry points (`workflow.mjs`, `sync.mjs`, `jev-evaluate.mjs`, `session_cost.py`).
- Strict assertions (`node:assert/strict`) verify exit codes, JSON outputs, state changes, and artifact integrity.
- Ephemeral directories and resources are released in `finally` blocks.

## Integration Points
- **Runtimes**: Native `node:test`, `node:assert/strict`, `child_process`, and Python 3 `unittest`.
- **Target Modules**: Direct imports and CLI subprocesses for `tools/*.mjs`, `tools/session_cost.py`, and `agent/extensions/nullform-jev.ts`.
- **Fixtures**: Consumes datasets in `fixtures/jev/` (`calibration.json`, `heldout.json`) and logs in `fixtures/cache/*.jsonl`.
