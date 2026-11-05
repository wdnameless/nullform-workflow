# adoption-program — tasks

## Phase A
- [ ] A1 (R01,R04): settle safe target resolution, protected refs, fail-loud,
  positional dispatch. Zone: tools/workflow-ci.mjs, tools/workflow.mjs,
  tools/tests/task-claim.test.mjs, tools/tests/workflow-gate.test.mjs.
- [ ] A2 (R02): real install-smoke isolated root/home + target verification.
  Zone: .github/workflows/repo-gate.yml, tools/install-harness.mjs (only if
  required), tools/tests/install-harness.test.mjs.
- [ ] A3 (R03): replay/dashboard port allocation no close/relisten race.
  Zone: tools/tests/replay.test.mjs, tools/tests/dashboard*.test.mjs and only
  directly necessary server test helpers.

## Phase B
- [ ] B1 (R05): verify path/name semantics. Zone: tools/verify.mjs,
  tools/tests/verify-matrix.test.mjs, tools/tests/install-harness.test.mjs.
- [ ] B2 (R06): experience content validation. Zone: tools/workflow-core.mjs,
  tools/tests/workflow-gate.test.mjs.
- [ ] B3 (R06): registry duplicate/orphan resolution and workflow-ci entrypoint/
  codemap refresh. Zone: skills-lock/registry sources as existing, affected
  skills metadata, tools/workflow-ci.mjs, CODEMAP.md trees.

## Phase C
- [ ] C1 (R07): scope classifier. Zone: tools/changed-scope.mjs, focused tests,
  CLI/docs references.
- [x] C2 (R08): skill security scanner, per-skill evals, trigger fixtures,
  registry lint. Zone: tools/skills-doctor.mjs or existing skill audit seam,
  focused tests, skills metadata/evals, CI relevant step.
- [ ] C3 (R09): worker brief/input-gap/FIX fresh-redispatch contract. Zone:
  tools/return-contract.mjs, focused tests, existing delegation templates only
  where user-approved (do not edit prompt surfaces without explicit permission).
- [ ] C4 (R10): offline dependency diagnosis. Zone: existing dependency audit
  seam, focused tests, no new deps.
- [ ] C5 (R11): candidate-only optimizer baseline→one mutation→reeval→keep/
  revert with $10 ledger. Zone: existing bench/eval seam, new focused tests,
  candidate output only.

## Phase D
- [ ] D1 (R12): full relevant verification, isolated repro, spend ledger,
  final blind oracle, final report.
