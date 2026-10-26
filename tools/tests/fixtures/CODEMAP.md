# tools/tests/fixtures/

## Responsibility
Immutable golden inputs, recorded JSONL session streams, and synthetic execution helpers consumed by the `tools/tests/` test suites; not executable product code. Provides deterministic inputs for cache observability, JEV benchmark evaluation, return contract parsing, and native review pipeline testing.

## Design Patterns
- **Dynamic Test Double / Synthetic Generator**: Executable helper (`review-execution.mjs`) importing review primitives from `tools/review/evidence.mjs` and `tools/review/native-tools.mjs`, exporting:
  - `nativeRunner(sessionId, usage, verdict, extra)`: factory returning `({ root, changeId, productCommand, provenance }) => { status: number, stdout: string }` synthesizing serialized native JSONL session streams (`session`, `model_change`, `workflow-review-context`, conditional `workflow-product-execution`, and `message` assistant verdict records).
  - `prepareEvidence(root, changeId)`: idempotent file generator creating test repository scaffolding (`agent/agents/reviewer.md`, `agent/agents/oracle.md`, and `tests/product.test.cjs`).
  - `writeEvidence(root, changeDir, changeId, overrides)`: test-double coordinator running full review lifecycle (`runReviewRecord`, `recordStageB` before/after, oracle verdict) and persisting `review-evidence.json`, returning the parsed evidence object.
- **Golden File / Static Fixture**: Recorded event streams, fingerprint snapshots, evaluation datasets, and spec documents preserving canonical test payloads:
  - Evaluation datasets (`jev/calibration.json`, `jev/heldout.json`): JSON fixtures exporting arrays of `{ id, prompt, expectedSkills, archetype, isSafetyCanary, lang }` records (14 calibration cases, 44 held-out cases; `outcomes.json` retired in v2).
  - Return contract specification (`return-contract/valid.md`): canonical subagent return contract markdown document shape with `STATUS`, `FILES`, `TESTS`, `INTERFACES`, `REQUIREMENTS`, and `CONCERNS` blocks.
  - Cache telemetry streams (`cache/*.jsonl`) and fingerprint state (`cache/fingerprint-old.json`, `cache/fingerprint-new.json`): multi-turn session records and configuration digests.

## Data & Control Flow
1. **Review Execution Helper (`review-execution.mjs`)**: Imported and executed by review, workflow, and safety test suites (`tools/tests/review-evidence.test.mjs`, `tools/tests/review-integrity.test.mjs`, `tools/tests/workflow-gate.test.mjs`, `tools/tests/workflow-staleness.test.mjs`, `tools/tests/oss-safety.test.mjs`, `tools/tests/review-boundaries.test.mjs`, `tools/tests/review-controlled-http.test.mjs`) to simulate native runner JSONL event output, oracle verification execution, and Stage-B review evidence generation without live LLM calls.
2. **JEV Evaluation Datasets (`jev/calibration.json`, `jev/heldout.json`)**: Loaded directly by `tools/tests/jev-evaluate.test.mjs` and through `tools/jev-evidence.mjs` (`loadEvaluationDatasetContext`) in `tools/tests/jev-evidence.test.mjs`, `tools/jev-assist.mjs`, and `tools/jev-control.mjs` to validate schema conformity, safety canaries, and paired skill evaluation coverage.
3. **Return Contract Fixtures (`return-contract/valid.md`)**: Read and asserted against by `tools/tests/return-contract.test.mjs` to verify acceptance of canonical subagent return contract markdown format.
4. **Cache Telemetry Fixtures (`cache/*.jsonl`, `cache/*.json`)**: Replayed verbatim and asserted against by `tools/tests/cache-doctor.test.mjs` and `tools/tests/test_session_cost.py` to verify prompt caching metrics, fallback transitions, model switches, and fingerprint drift (`fingerprint-old.json` vs `fingerprint-new.json`).

## Integration Points
- `tools/tests/fixtures/review-execution.mjs`: Imported by `tools/tests/review-evidence.test.mjs`, `tools/tests/review-integrity.test.mjs`, `tools/tests/workflow-gate.test.mjs`, `tools/tests/workflow-staleness.test.mjs`, `tools/tests/oss-safety.test.mjs`, `tools/tests/review-boundaries.test.mjs`, and `tools/tests/review-controlled-http.test.mjs`. Interacts with `tools/review/evidence.mjs` (`runReviewRecord`, `recordStageB`, `loadReviewEvidence`, `saveReviewEvidence`) and `tools/review/native-tools.mjs` (`executeProduct`).
- `tools/tests/fixtures/jev/`: Consumed by `tools/tests/jev-evaluate.test.mjs`, `tools/tests/jev-evidence.test.mjs`, and dataset loader `tools/jev-evidence.mjs` (`loadEvaluationDatasetContext`).
- `tools/tests/fixtures/return-contract/`: Consumed by `tools/tests/return-contract.test.mjs`.
- `tools/tests/fixtures/cache/`: Consumed by `tools/tests/cache-doctor.test.mjs` and `tools/tests/test_session_cost.py`.
