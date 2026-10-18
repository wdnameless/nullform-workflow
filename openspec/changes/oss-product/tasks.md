## Research and contract gates
- [x] W0 Record user scope: no paid experiments, our managed instruction changes allowed, preserve human/global config. R01-R12.
- [ ] E1 Primary-source native contract and no-overhead research. R02 R03 R09 R10 R12. blocked-by: W0
- [ ] E2 Inventory safe internal-module cutover and one-command setup reuse. R03 R04 R05. blocked-by: W0
- [ ] G2 Independent brief-to-spec gap review; close material gaps before source GO. R01-R12. blocked-by: E1 E2

## Semantic fixes and adaptive setup
- [ ] S1 SafetyOwner: six failing regression scenarios; parent before-run. R01. blocked-by: W0
- [ ] S2 SafetyOwner: six root fixes and shared invariant checks where justified; parent focused verification and real CLI/loopback smoke. R01. blocked-by: G2 S1
- [ ] A1 SetupOwner: safe client discovery/selection and source-verified minimal native policy; parent isolated setup/reapply/error smokes. R03 R09 R10 R12. blocked-by: G2 E1

## Structure and public evidence
- [ ] M1 StructureOwner: move cohesive internals, migrate every caller/deployment inventory and nested doctor checks; preserve actual entrypoints. R04 R05. blocked-by: S2 A1 E2
- [ ] D1 Public docs/navigation/compatibility and evidence claims; no unmeasured superiority. R02 R06 R07 R08 R11 R12. blocked-by: E1 M1
- [ ] V1 Parent full deterministic regression and real exact-archive npm install/update smoke; size, confinement and packaging gates. R01 R03 R04 R05 R08 R10. blocked-by: M1 D1
- [ ] V2 Independent implementation review, frozen-test simplification, blind manifest/runtime acceptance. R01-R12. blocked-by: V1
- [ ] R1 Prepare source/artifact/CI release evidence and explicitly report unreachable live-acceptance/registry prerequisites; never publish uncertified bytes. R03 R06 R07 R11. blocked-by: V2
