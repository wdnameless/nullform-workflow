# tools/tests/fixtures/

## Responsibility
Immutable golden inputs, recorded JSONL session streams, and synthetic execution helpers consumed by the `tools/tests/` test suites; not executable product code. Provides deterministic inputs for cache observability, JEV benchmark evaluation, return contract parsing, and native review pipeline testing.

## Design Patterns
- **Golden File / Static Fixture**: Recorded event streams (`cache/*.jsonl`), fingerprint snapshots (`cache/*.json`), evaluation benchmarks (`jev/*.json`), and spec documents (`return-contract/valid.md`) preserving canonical test payloads.
- **Dynamic Test Double / Synthetic Generator**: Executable helper (`review-execution.mjs`) implementing `nativeRunner`, `prepareEvidence`, and `writeEvidence` to synthesize native JSONL session events, oracle verdicts, and Stage-B evidence records.

## Data & Control Flow
1. **Cache Telemetry Fixtures (`cache/*.jsonl`, `cache/*.json`)**: Replayed verbatim and asserted against by `tools/tests/cache-doctor.test.mjs` and `tools/tests/test_session_cost.py` to verify prompt caching metrics, fallback transitions, model switches, and fingerprint drift (`fingerprint-old.json` vs `fingerprint-new.json`).
2. **JEV Evaluation Datasets (`jev/calibration.json`, `jev/heldout.json`)**: Replayed and asserted against by `tools/tests/jev-evaluate.test.mjs` to validate schema conformity, prompt disjointness, and paired evaluation harness thresholds.
3. **Return Contract Fixtures (`return-contract/valid.md`)**: Read and asserted against by `tools/tests/return-contract.test.mjs` to verify acceptance of canonical subagent return contract markdown format.
4. **Review Execution Fixture (`review-execution.mjs`)**: The sole executable fixture in this directory; called by `tools/tests/review-evidence.test.mjs`, `tools/tests/review-integrity.test.mjs`, `tools/tests/workflow-gate.test.mjs`, and `tools/tests/workflow-staleness.test.mjs` to simulate native runner JSONL event output, oracle verification execution, and Stage-B review evidence generation.

## Integration Points
- `tools/tests/fixtures/cache/`: Consumed by `tools/tests/cache-doctor.test.mjs` and `tools/tests/test_session_cost.py`.
- `tools/tests/fixtures/jev/`: Consumed by `tools/tests/jev-evaluate.test.mjs`.
- `tools/tests/fixtures/return-contract/`: Consumed by `tools/tests/return-contract.test.mjs`.
- `tools/tests/fixtures/review-execution.mjs`: Imported and executed by `tools/tests/review-evidence.test.mjs`, `tools/tests/review-integrity.test.mjs`, `tools/tests/workflow-gate.test.mjs`, and `tools/tests/workflow-staleness.test.mjs`.
