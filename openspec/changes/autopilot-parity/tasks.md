# Autopilot parity tasks

## Slice A — Run control (R01/R02/R05)
- [ ] Mode/depth dials in `start` with validation.
- [ ] Brief freeze + redaction gate, brief-only oracle input.
- [ ] Requirement types/statuses + mechanical recount.
- [ ] Tests: dials, freeze/redact, parse/recount.

## Slice B — Plan gates (R03/R06/R07)
- [ ] G3 plan validator: coverage, topology, disjoint zones.
- [ ] G2 blind coverage check: spec vs brief, no manifest.
- [ ] G4 isolated temp-clone acceptance from brief only.
- [ ] Tests: validator, coverage gate, clone isolation.

## Slice C — Build discipline (R04/R08/R09)
- [ ] REDPROOF worker contract + 25-line limit.
- [ ] 8-dimension depth + 7-question adversarial checklists.
- [ ] Three-axis review + F1 consolidation + repair limits.
- [ ] Tests: contract, checklists, review/limits.

## Slice D — Ops journal (R10/R11/R12)
- [ ] Beats + honest time, waits, commits check, trailers.
- [ ] Carried debts, normalized cost, skills-lock verify.
- [ ] Snapshot dashboard, graceful server, collision detect.
- [ ] Tests: journal, carry/cost/lock, snapshot/server.

## Integration (parent)
- [ ] Merge slices from isolated worktrees, resolve conflicts.
- [ ] Run deterministic gates (tests/lint/size) and blind oracle acceptance.
