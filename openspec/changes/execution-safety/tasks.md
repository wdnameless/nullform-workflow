# Tasks

- [x] G2: Independent brief-to-spec review by ClaimsOwner and ModelOwner; overlap gap and exact contract limits closed before source implementation. Parent owns prerequisites and gates. R01–R07.
- [ ] C01: ClaimsOwner writes consumer-visible failing regressions, then fixes token disclosure, canonical paths, serialized ownership transitions and contract-bound packets; no runtime tests during shared build wave. R01 R03 R06.
- [ ] M01: ModelOwner implements explicit route/financial admission, zero-cost validation, safe completed-session resume, deterministic consumer regressions and exact CLI dispatch; no live inference, no runtime tests during shared build wave. R02 R04 R06 R07.
- [ ] H01: HermesOwner corrects the real-client compatibility gap with additive native agent.system_prompt, focused failing regressions, preservation/override checks and caller migrations; parent verifies the actual installed loader without inference. R05 R06.
- [ ] V01: Parent integrates disjoint owned files, executes regressions and actual CLI smoke, checks installed native-client prerequisites without inference, returns concrete bugs to owner, and freezes integrated non-acceptance source. blocked-by: C01 M01 H01. R01–R07.
- [ ] D01: ModelOwner updates existing README/CONTEXT after smoke to document actual claims, policy, supported financial boundary, recovery and live-client limits, preserving not-proven quality. blocked-by: V01. R04 R05 R06 R07.
- [ ] A01: Independent implementation review plus original-manifest runtime acceptance on a permitted direct route, only if invocation is separately authorized and source is frozen; no fabricated native receipt or forced close. blocked-by: D01. R06 R07.

Return contract for every worker: STATUS | FILES paths-only | TESTS actual executed counts or not-run | INTERFACES signatures/CLI | REQUIREMENTS R## mapping | CONCERNS/BLOCKERS, at most 25 lines. Parent executes behavioral verification after integration; workers skip build/lint/tests/formatters mid-flight and do not create .workflow state, commit, publish, edit personal prompts or call another model/provider. The reported audit failures are ground truth and are not rerun to confirm.
