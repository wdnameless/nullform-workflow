## Research and contract gates
- [x] W0 Record user scope: no paid experiments, our managed instruction changes allowed, preserve human/global config. R01-R12.
- [x] E1 Primary-source native contract and no-overhead research; source-linked runtime unknowns explicit. R02 R03 R09 R10 R12. blocked-by: W0
- [x] E2 Inventory safe internal-module cutover and one-command setup reuse. R03 R04 R05. blocked-by: W0
- [x] G2 Independent brief-to-spec gap review ACCEPT; no material coverage gaps. R01-R12. blocked-by: E1 E2

## Semantic fixes and adaptive setup
- [x] S1 SafetyOwner: six failing regression scenarios; parent before-run9counted1pass8fail. R01. blocked-by: W0
- [x] S2 SafetyOwner: six root fixes,9-regression cohort and25financial invariants pass; independent real CLI/accounting smoke passes. R01. blocked-by: G2 S1
- [x] A1 SetupOwner: safe discovery/selection, minimal OMP/doctor and preservation; parent67case run65pass plus2test-only corrections verified2/2. Exact archive and all-client reconciliation remain V1. R03 R09 R10 R12. blocked-by: G2 E1
- [x] P1 PolicyOwner: native-first bootstrap and canonical opt-in guide; parent81surface/71skill checks passed. R05 R09 R10 R12. blocked-by: G2 E1
- [ ] A2 Integration owner: preserve existing OpenClaw SOUL/USER bytes, remove unused identity generators and migrate affected behavior regressions; parent actual installer smoke reproduced both files changing before correction. R09 R12. blocked-by: A1

## Structure and public evidence
- [ ] M1 StructureOwner: after A2, move cohesive internals, migrate every caller/deployment inventory and nested doctor checks; preserve actual entrypoints and journal exact obsolete owned-module removals. A2 and M1 have one integration owner to avoid overlapping movers. R04 R05. blocked-by: S2 A1 A2 P1 E2
- [ ] D1 Public docs/navigation/compatibility and evidence claims; no unmeasured superiority. R02 R06 R07 R08 R11 R12. blocked-by: E1 M1
- [ ] V1 Parent full deterministic regression and real exact-archive npm install/update smoke; size, confinement and packaging gates. R01 R03 R04 R05 R08 R10. blocked-by: M1 D1
- [ ] V2 Independent implementation review, frozen-test simplification, blind manifest/runtime acceptance. R01-R12. blocked-by: V1
- [ ] R1 Prepare source/artifact/CI release evidence and explicitly report unreachable live-acceptance/registry prerequisites; never publish uncertified bytes. R03 R06 R07 R11. blocked-by: V2
