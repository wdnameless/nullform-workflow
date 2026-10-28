# universal-slices-wizard — tasks

## Ready frontier (Wave 3, parallel, disjoint)

- [ ] T1. Gates reuse (R03): changed-scope --root/--suites, clone .clone.json,
  nullform quality code-size, docs/GATES.md. Zone: tools/changed-scope.mjs,
  tools/mutation-changed.mjs, tools/coverage-changed.mjs,
  tools/clone-coverage.mjs, tools/code-size.mjs (CLI expose only),
  bin/nullform.mjs (quality passthrough), docs/GATES.md, тесты. Owner: @fixer.
- [ ] T2. Wizard+matrix (R01+R02+R06): tools/harness-matrix.json + init шаги
  (flow/harness/slices/dry-run/confirm/back) + тесты на piped stdin.
  Zone: tools/harness-matrix.json, bin/nullform.mjs (init path),
  tools/tests/init-wizard.test.mjs (new). Owner: @fixer. Depends: T1 (slices
  как install-опции; имена слайсов из T3-черновика — взять из interfaces).
- [ ] T3. Docs+prompt (R04+R05): docs/SLICES.md, docs/AGENT-INTEGRATION.md,
  prompts/integration.md. Zone: docs/SLICES.md, docs/AGENT-INTEGRATION.md,
  prompts/integration.md. Owner: @sonic.
- [ ] T4. Roles one-liners (R01): NEXUS в reviewer.md, Reality Checker в
  oracle.md. Zone: agent/agents/reviewer.md, agent/agents/oracle.md.
  Owner: @sonic.

## Integration (parent)

- [ ] T5. Reconcile: validate --strict, A1–A6 proofs (чужой фикстурный проект,
  dry-run 4 харнесса, piped wizard), gates, commit.
- [ ] T6. Oracle vs manifest (blind) + merge + close.
